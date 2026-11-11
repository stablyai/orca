import { tmpdir } from 'node:os'
import { vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

import './orchestration-codex-completion-title.spec'
import './orchestration-cursor-native-title.spec'
import '../../../terminal/output/stale-title-completion-recovery.spec'
