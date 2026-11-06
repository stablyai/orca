import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import {
  ORCAD_LOG_FILENAME,
  ORCAD_PID_FILENAME,
  ORCAD_READINESS_FILENAME
} from './orcad-remote-host-support'
import { orcadLaunchCommand } from './orcad-remote-launch'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { WORKER_CODE_RANGE_MB } from '../../worker-threads/worker-thread-spawn'

const host = getRemoteHostPlatform('linux-x64')
const NODE_SHA = 'e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79b'
// The reporter's HPC limit (#37538).
const ADDRESS_SPACE_LIMIT_KB = 8 * 1024 * 1024
const READY_LINE = '{"type":"orca_server_ready"}'

// Like orcad: one fetch, then worker threads spawned with spawnWorkerThread()'s limits.
const ENTRY = `
const { Worker } = require('node:worker_threads')
const server = require('node:http').createServer((_req, res) => res.end()).listen(0, async () => {
  await (await fetch('http://127.0.0.1:' + server.address().port)).text()
  server.close()
  const workers = []
  for (let i = 0; i < 24; i++) {
    const worker = new Worker('require("node:worker_threads").parentPort.postMessage(0); setInterval(() => {}, 1e9)', {
      eval: true,
      resourceLimits: { codeRangeSizeMb: ${WORKER_CODE_RANGE_MB} }
    })
    await new Promise((resolve) => worker.once('message', resolve))
    workers.push(worker)
  }
  console.log(${JSON.stringify(READY_LINE)})
  process.exit(0)
})
`

const slots: string[] = []
afterEach(() => {
  for (const slot of slots.splice(0)) {
    // A hung launch would otherwise outlive the test with live workers.
    const pid = Number(read(slot, ORCAD_PID_FILENAME))
    if (pid > 0) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already exited.
      }
    }
    rmSync(join(slot, '..'), { recursive: true, force: true })
  }
})

function read(slot: string, name: string): string {
  try {
    return readFileSync(join(slot, name), 'utf8')
  } catch {
    return ''
  }
}

function pinnedNodeSlot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orcad-address-space-'))
  const slot = join(root, 'orcad-0.2.0+bb01')
  mkdirSync(slot)
  slots.push(slot)
  writeFileSync(join(slot, '.runtime-node'), `${NODE_SHA}\n`)
  const binDir = join(root, 'runtimes', `node-${NODE_SHA}`, 'bin')
  mkdirSync(binDir, { recursive: true })
  symlinkSync(process.execPath, join(binDir, 'node'))
  writeFileSync(join(slot, 'orcad.js'), ENTRY)
  return slot
}

// RLIMIT_AS is enforced only on Linux.
describe.skipIf(process.platform !== 'linux')('orcad under an address-space limit', () => {
  // Covers the 20 s wait for the detached launch below.
  it('starts workers after a fetch within 8 GiB of virtual memory', async () => {
    const slot = pinnedNodeSlot()
    const command = orcadLaunchCommand(host, {
      remoteInstallDir: slot,
      nodePath: '/missing-host-node',
      fullVersion: '0.2.0+bb01',
      userDataDir: join(slot, 'user-data'),
      bindHost: '127.0.0.1',
      port: 7777,
      activationRoot: join(slot, 'activation')
    })
    await runProcess({
      program: '/bin/sh',
      args: ['-c', `ulimit -v ${ADDRESS_SPACE_LIMIT_KB}; ${command}`],
      timeoutMs: 10_000
    })
    // Spawning 24 isolates under a VM limit takes seconds on a loaded CI runner.
    await vi.waitFor(
      () => {
        const log = read(slot, ORCAD_LOG_FILENAME)
        expect(log).not.toContain('Fatal')
        expect(read(slot, ORCAD_READINESS_FILENAME), log).toContain(READY_LINE)
      },
      { timeout: 20_000, interval: 50 }
    )
  }, 30_000)
})
