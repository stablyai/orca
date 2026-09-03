/**
 * The probe and reap scripts run on someone else's machine and decide whether a process is
 * signalled, so the shell itself is the part worth testing for real. These cases run the
 * generated scripts through /bin/sh against real unix sockets and real processes.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  isReapableRelayHusk,
  parseRelayEndpointIncumbentProbe,
  relayEndpointIncumbentProbeCommand,
  type RelayEndpointIncumbent
} from './ssh-relay-endpoint-incumbent'
import { reapEmptyRelayHuskCommand } from './ssh-relay-endpoint-takeover'

const posixOnly = process.platform === 'win32' ? describe.skip : describe

const FAKE_RELAY_SOURCE = `
const net = require('net')
const sock = process.argv[process.argv.indexOf('--sock-path') + 1]
if (process.argv.includes('--with-child')) {
  require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore'
  })
}
net.createServer(() => {}).listen(sock, () => process.stdout.write('READY\\n'))
process.on('SIGTERM', () => process.exit(0))
`

function sh(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/bin/sh', ['-c', script], { timeout: 20_000 }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
}

let workDir: string
let hasLsof = false
const running: ChildProcess[] = []

function startFakeRelay(sockPath: string, withChild = false): Promise<ChildProcess> {
  const args = [join(workDir, 'relay.js'), '--sock-path', sockPath]
  if (withChild) {
    args.push('--with-child')
  }
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'ignore'] })
  running.push(child)
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('READY')) {
        resolve(child)
      }
    })
    child.on('exit', () => reject(new Error('fake relay exited before listening')))
  })
}

async function probe(sockPath: string): Promise<RelayEndpointIncumbent> {
  const output = await sh(relayEndpointIncumbentProbeCommand(process.execPath, sockPath))
  return parseRelayEndpointIncumbentProbe(sockPath, output)
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'orca-relay-incumbent-'))
  writeFileSync(join(workDir, 'relay.js'), FAKE_RELAY_SOURCE)
  hasLsof = await sh('command -v lsof >/dev/null 2>&1 && echo yes || echo no').then(
    (out) => out.trim() === 'yes'
  )
})

afterEach(() => {
  while (running.length > 0) {
    running.pop()?.kill('SIGKILL')
  }
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

it('runs the holder-enumeration assertions on this machine', () => {
  // Why asserted rather than assumed: the cases below degrade to verdict-only checks without
  // lsof, and a silently degraded suite would stop covering the reap gate entirely.
  expect(hasLsof).toBe(true)
})

posixOnly('relay endpoint probe against a real socket', () => {
  it('reports live, and identifies the holding process, for a listening relay', async () => {
    const sockPath = join(workDir, 'live.sock')
    const relay = await startFakeRelay(sockPath)
    const incumbent = await probe(sockPath)

    expect(incumbent.verdict).toBe('live')
    expect(incumbent.evidence).toBe('accepted-connection')
    expect(incumbent.socketPresent).toBe(true)
    if (!hasLsof) {
      return
    }
    expect(incumbent.holders.map((holder) => holder.pid)).toEqual([relay.pid])
    expect(incumbent.holders[0]).toMatchObject({ matchesRelayArgv: true, childCount: 0 })
    expect(isReapableRelayHusk(incumbent)).toBe(true)
  })

  it('refuses to call a relay with a live child an empty husk', async () => {
    const sockPath = join(workDir, 'busy.sock')
    await startFakeRelay(sockPath, true)
    const incumbent = await probe(sockPath)

    expect(incumbent.verdict).toBe('live')
    if (!hasLsof) {
      return
    }
    expect(incumbent.holders[0].childCount).toBeGreaterThan(0)
    expect(isReapableRelayHusk(incumbent)).toBe(false)
  })

  it('reports exited for a socket inode a SIGKILLed relay left behind', async () => {
    const sockPath = join(workDir, 'stale.sock')
    const relay = await startFakeRelay(sockPath)
    relay.kill('SIGKILL')
    await new Promise((resolve) => relay.on('exit', resolve))

    const incumbent = await probe(sockPath)
    expect(incumbent.socketPresent).toBe(true)
    expect(incumbent.verdict).toBe(hasLsof ? 'exited' : 'unverifiable')
  })

  it('reports no listener for a path that was never bound', async () => {
    const incumbent = await probe(join(workDir, 'never-existed.sock'))
    expect(incumbent.socketPresent).toBe(false)
    expect(incumbent.verdict).toBe(hasLsof ? 'exited' : 'unverifiable')
  })
})

posixOnly('empty relay husk reap against a real process', () => {
  it('terminates a proven-empty relay and confirms the pid is gone', async () => {
    const sockPath = join(workDir, 'husk.sock')
    const relay = await startFakeRelay(sockPath)
    const output = await sh(reapEmptyRelayHuskCommand(relay.pid!, sockPath))
    expect(output.trim()).toBe('GONE')
  })

  it('refuses to signal a relay that acquired a child after it was probed', async () => {
    const sockPath = join(workDir, 'raced.sock')
    const relay = await startFakeRelay(sockPath, true)
    const output = await sh(reapEmptyRelayHuskCommand(relay.pid!, sockPath))
    expect(output.trim()).toBe('BUSY')
    expect(relay.killed).toBe(false)
  })

  it('refuses to signal a pid whose argv is not this relay at this socket', async () => {
    const sockPath = join(workDir, 'mismatch.sock')
    await startFakeRelay(sockPath)
    const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore'
    })
    running.push(bystander)
    const output = await sh(reapEmptyRelayHuskCommand(bystander.pid!, sockPath))
    expect(output.trim()).toBe('MISMATCH')
    expect(bystander.killed).toBe(false)
  })
})
