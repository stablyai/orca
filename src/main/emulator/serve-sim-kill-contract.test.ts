import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))

import { serveSimKillArgs } from './serve-sim-execution'

const SERVE_SIM_ENTRY = join(
  dirname(createRequire(import.meta.url).resolve('serve-sim/package.json')),
  'dist',
  'serve-sim.js'
)
const DEVICE_A = 'AAAAAAAA-0000-0000-0000-000000000001'
const DEVICE_B = 'BBBBBBBB-0000-0000-0000-000000000002'

const helpers: ChildProcess[] = []
const tempDirs: string[] = []

afterEach(() => {
  for (const helper of helpers.splice(0)) {
    helper.kill('SIGKILL')
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function isAlive(helper: ChildProcess): boolean {
  return helper.exitCode === null && helper.signalCode === null
}

// TMPDIR isolates serve-sim's state dir so only these fake helpers are reachable.
describe.skipIf(process.platform === 'win32')('serve-sim kill contract', () => {
  it('stops only the named device helper', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'orca-serve-sim-kill-'))
    tempDirs.push(stateRoot)
    mkdirSync(join(stateRoot, 'serve-sim'))
    const [helperA, helperB] = [DEVICE_A, DEVICE_B].map((device) => {
      const helper = spawn('sleep', ['600'], { stdio: 'ignore' })
      helpers.push(helper)
      // Port 0 keeps serve-sim's port-holder sweep from touching real listeners.
      writeFileSync(
        join(stateRoot, 'serve-sim', `server-${device}.json`),
        JSON.stringify({ pid: helper.pid, port: 0, device, url: 'u', streamUrl: 's', wsUrl: 'w' })
      )
      return helper
    })

    execFileSync(process.execPath, [SERVE_SIM_ENTRY, ...serveSimKillArgs(DEVICE_A)], {
      env: { ...process.env, TMPDIR: stateRoot }
    })

    await vi.waitFor(() => expect(isAlive(helperA)).toBe(false))
    expect(isAlive(helperB)).toBe(true)
    expect(existsSync(join(stateRoot, 'serve-sim', `server-${DEVICE_B}.json`))).toBe(true)
  })
})
