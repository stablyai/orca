import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { legacyDaemonProcessMayBeAlive } from './daemon-legacy-process-liveness'
import { getDaemonPidPath, serializeDaemonPidFile } from './daemon-spawner'

let runtimeDir: string
beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'orca-legacy-liveness-'))
  writeFileSync(
    getDaemonPidPath(runtimeDir, 50),
    serializeDaemonPidFile({ pid: 424242, startedAtMs: Date.parse('2026-01-01T00:00:00Z') })
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(runtimeDir, { recursive: true, force: true })
})

function killFailsWith(code: string): void {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error(code), { code })
  })
}

it('counts a process it may not signal (EPERM) as alive', () => {
  killFailsWith('EPERM')
  expect(legacyDaemonProcessMayBeAlive(runtimeDir, 50)).toBe(true)
})

it('counts only a missing process (ESRCH) as gone', () => {
  killFailsWith('ESRCH')
  expect(legacyDaemonProcessMayBeAlive(runtimeDir, 50)).toBe(false)
})

it('counts a version with no pid file as gone', () => {
  expect(legacyDaemonProcessMayBeAlive(runtimeDir, 49)).toBe(false)
})
