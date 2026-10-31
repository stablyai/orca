import { tmpdir } from 'node:os'
import { vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

import './orchestration-dispatch-mailbox-delivery.spec'
import './orchestration-mailbox-pointer-cli-command.spec'
import './orchestration-mailbox-transport-settlement.spec'
import './orchestration-mailbox-cold-park-idle.spec'
import './orchestration-mailbox-typed-pointer-submit.spec'
