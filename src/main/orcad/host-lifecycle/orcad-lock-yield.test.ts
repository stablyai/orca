import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../browser-providers/orcad-browser-startup', () => ({
  startOrcadBrowserProvider: () => ({ ready: Promise.resolve(), stop: async () => {} })
}))

import {
  acquireOrcadInstanceLock,
  ORCAD_LOCK_FILE_NAME
} from '../instance-lock/orcad-instance-lock'
import { readOrcadInstanceLockRecord } from '../instance-lock/orcad-instance-lock-record'
import { installOrcadShutdownSignals, startOrcadWithHost } from './orcad-lifecycle'
import { ORCAD_LOCK_HEARTBEAT_MS } from '../instance-lock/orcad-lock-clone-machine'
import { orcadRunFailed } from './orcad-unexpected-exit'
import { SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE } from '../../../shared/single-instance-exit-code'
import { _resetPendingWorktreeRemovalsForTests } from '../../workspaces/removal/worktree-background-removal'

const roots: string[] = []
afterEach(() => {
  // Drops the shutdown deadline timer so it cannot call the real process.exit later.
  vi.useRealTimers()
  vi.restoreAllMocks()
  _resetPendingWorktreeRemovalsForTests()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

// Counting a yield as a crash would feed the supervisor's crash-loop brake.
it('yields a lost instance lock to its new holder without counting a failed run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orcad-lock-yield-'))
  roots.push(root)
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
  vi.spyOn(process, 'on').mockImplementation(() => process)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub only records the code; nothing after process.exit runs here.
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const handle = await startOrcadWithHost(
    root,
    async () => ({}),
    () => {}
  )
  installOrcadShutdownSignals(() => handle.stop())
  const lockPath = join(root, ORCAD_LOCK_FILE_NAME)
  rmSync(lockPath)
  const successor = acquireOrcadInstanceLock(root)

  vi.advanceTimersByTime(ORCAD_LOCK_HEARTBEAT_MS)
  await vi.waitFor(
    () => expect(exit).toHaveBeenCalledWith(SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE),
    { interval: 1 }
  )
  expect(orcadRunFailed()).toBe(false)
  expect(readOrcadInstanceLockRecord(lockPath)?.nonce).toBe(successor.record.nonce)
  successor.release()
})
