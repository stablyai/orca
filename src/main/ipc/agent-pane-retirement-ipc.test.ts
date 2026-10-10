import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  retire: vi.fn(),
  clear: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    removeAllListeners: vi.fn(),
    on: (name: string, callback: (...args: unknown[]) => void) => mocks.handlers.set(name, callback)
  }
}))
vi.mock('../agent-hooks/server', () => ({
  agentHookServer: { retirePaneAuthority: mocks.retire },
  isValidPaneKey: (key: string) => key.includes(':')
}))
vi.mock('../agent-hooks/migration-unsupported-pty-state', () => ({
  clearMigrationUnsupportedPtysForPaneKey: mocks.clear
}))
import { registerAgentPaneAuthorityIpcHandlers } from './agent-pane-authority-ipc'
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const paneKey = makePaneKey('tab-1', id)
beforeEach(() => {
  vi.clearAllMocks()
  registerAgentPaneAuthorityIpcHandlers({ ownsPty: () => false })
})

describe('pane retirement IPC request identity', () => {
  it.each([undefined, id])('accepts legacy omission or a valid UUID: %s', (requestId) => {
    mocks.handlers.get('agentStatus:retirePaneAuthority')?.({}, paneKey, requestId)
    expect(mocks.retire).toHaveBeenCalledWith(paneKey, requestId)
  })
  it.each([null, '', 'bad-id', 42, {}, `${id} `])(
    'rejects malformed request identity %j',
    (requestId) => {
      mocks.handlers.get('agentStatus:retirePaneAuthority')?.({}, paneKey, requestId)
      expect(mocks.retire).not.toHaveBeenCalled()
      expect(mocks.clear).not.toHaveBeenCalled()
    }
  )
})
