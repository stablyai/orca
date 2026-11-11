import { tmpdir } from 'node:os'
import { vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

import '../terminal-pointer/orchestration-mailbox-crash-recovery.spec'
import './orchestration-mailbox-detached-routing.spec'
import './orchestration-mailbox-filtered-waiters.spec'
import './orchestration-mailbox-routing-races.spec'
import '../terminal-pointer/orchestration-multi-run-coordinator-wake.spec'
import '../terminal-pointer/orchestration-dispatch-beside-helper-run.spec'
