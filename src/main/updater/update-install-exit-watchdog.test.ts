import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { exit: vi.fn() } }))

import { updateInstallExitTimeoutMs } from './update-install-exit-watchdog'

describe('updateInstallExitTimeoutMs', () => {
  // The NSIS check terminates whatever still runs from the install folder once its grace ends;
  // Orca must have exited on its own by then, with room for the installer's own startup.
  it('exits on Windows before the installer stops install-folder processes', () => {
    const check = readFileSync(join(process.cwd(), 'config/nsis/orca-process-check.nsh'), 'utf8')
    const grace = Number(/!define ORCA_UPDATE_EXIT_GRACE_MS (\d+)/.exec(check)?.[1])
    expect(grace).toBeGreaterThan(0)
    expect(grace - updateInstallExitTimeoutMs('win32')).toBeGreaterThanOrEqual(2_000)
  })
})
