import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as AgentHookServerModule from '../agent-hooks/server'
import { makePaneKey } from '../../shared/workspace-layout/stable-pane-id'

// Renderer dismissals must evict persisted status as well as the live row.

const dropStatusEntry = vi.fn()
const dropPersistedStatusEntry = vi.fn()
const dropPersistedStatusEntries = vi.fn(() => [] as string[])
const dropStatusEntriesByTabPrefix = vi.fn()
const retirePaneAuthority = vi.fn()
const transferPaneAuthority = vi.fn()
const canTransferPaneAuthority = vi.fn(() => true)
const getStatusSnapshot = vi.fn()
const inferInterrupt = vi.fn()
const clearMigrationUnsupportedPtysByTabPrefix = vi.fn()
const clearMigrationUnsupportedPtysForPaneKey = vi.fn()
const onHandlers = new Map<string, (event: unknown, ...args: unknown[]) => void>()
const handleHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
const removeHandler = vi.fn()
const removeAllListeners = vi.fn()
const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const CHILD_PANE_KEY = makePaneKey('tab-2', '22222222-2222-4222-8222-222222222222')

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handleHandlers.set(channel, handler)
    },
    on: (channel: string, handler: (event: unknown, ...args: unknown[]) => void) => {
      onHandlers.set(channel, handler)
    },
    removeHandler,
    removeAllListeners
  }
}))

vi.mock('../agent-hooks/server', async () => {
  // Use the real pane-key validator so invalid-input coverage tracks its constraints.
  const actual = await vi.importActual<typeof AgentHookServerModule>('../agent-hooks/server')
  return {
    ...actual,
    agentHookServer: {
      dropStatusEntry,
      dropPersistedStatusEntry,
      dropPersistedStatusEntries,
      dropStatusEntriesByTabPrefix,
      retirePaneAuthority,
      transferPaneAuthority,
      canTransferPaneAuthority,
      getStatusSnapshot,
      inferInterrupt
    }
  }
})

vi.mock('../agent-hooks/migration-unsupported-pty-state', () => ({
  clearMigrationUnsupportedPtysByTabPrefix,
  clearMigrationUnsupportedPtysForPaneKey,
  getMigrationUnsupportedPtySnapshot: vi.fn(() => [])
}))

vi.mock('../claude/hook-service', () => ({
  claudeHookService: { getStatus: vi.fn(() => ({ agent: 'claude', state: 'absent' })) }
}))
vi.mock('../openclaude/hook-service', () => ({
  openClaudeHookService: { getStatus: vi.fn(() => ({ agent: 'openclaude', state: 'absent' })) }
}))
vi.mock('../codex/hooks/installation/hook-service', () => ({
  codexHookService: { getStatus: vi.fn(() => ({ agent: 'codex', state: 'absent' })) }
}))
vi.mock('../gemini/hook-service', () => ({
  geminiHookService: { getStatus: vi.fn(() => ({ agent: 'gemini', state: 'absent' })) }
}))
vi.mock('../antigravity/hook-service', () => ({
  antigravityHookService: { getStatus: vi.fn(() => ({ agent: 'antigravity', state: 'absent' })) }
}))
vi.mock('../amp/hook-service', () => ({
  ampHookService: { getStatus: vi.fn(() => ({ agent: 'amp', state: 'absent' })) }
}))
vi.mock('../cursor/hook-service', () => ({
  cursorHookService: { getStatus: vi.fn(() => ({ agent: 'cursor', state: 'absent' })) }
}))
vi.mock('../droid/hook-service', () => ({
  droidHookService: { getStatus: vi.fn(() => ({ agent: 'droid', state: 'absent' })) }
}))
vi.mock('../command-code/hook-service', () => ({
  commandCodeHookService: { getStatus: vi.fn(() => ({ agent: 'command-code', state: 'absent' })) }
}))
vi.mock('../grok/hook-service', () => ({
  grokHookService: { getStatus: vi.fn(() => ({ agent: 'grok', state: 'absent' })) }
}))
vi.mock('../copilot/hook-service', () => ({
  copilotHookService: { getStatus: vi.fn(() => ({ agent: 'copilot', state: 'absent' })) }
}))
vi.mock('../hermes/hook-service', () => ({
  hermesHookService: { getStatus: vi.fn(() => ({ agent: 'hermes', state: 'absent' })) }
}))
vi.mock('../devin/hook-service', () => ({
  devinHookService: { getStatus: vi.fn(() => ({ agent: 'devin', state: 'absent' })) }
}))
vi.mock('../kimi/hook-service', () => ({
  kimiHookService: { getStatus: vi.fn(() => ({ agent: 'kimi', state: 'absent' })) }
}))

beforeEach(() => {
  dropStatusEntry.mockReset()
  dropPersistedStatusEntry.mockReset()
  dropPersistedStatusEntries.mockReset()
  dropPersistedStatusEntries.mockReturnValue([])
  dropStatusEntriesByTabPrefix.mockReset()
  retirePaneAuthority.mockReset()
  transferPaneAuthority.mockReset()
  canTransferPaneAuthority.mockReset()
  canTransferPaneAuthority.mockReturnValue(true)
  getStatusSnapshot.mockReset()
  inferInterrupt.mockReset()
  clearMigrationUnsupportedPtysByTabPrefix.mockReset()
  clearMigrationUnsupportedPtysForPaneKey.mockReset()
  onHandlers.clear()
  handleHandlers.clear()
  removeHandler.mockReset()
  removeAllListeners.mockReset()
})

afterEach(() => {
  vi.resetModules()
})

describe('agent pane authority IPC', () => {
  it('rejects unowned and oversized pane authority transfers', async () => {
    const { registerAgentHookHandlers } = await import('./agent-hooks')
    registerAgentHookHandlers()
    const transfer = onHandlers.get('agentStatus:transferPaneAuthority')!

    canTransferPaneAuthority.mockReturnValue(false)
    transfer({}, { fromPaneKey: PANE_KEY, toPaneKey: CHILD_PANE_KEY, ptyId: 'forged-pty' })
    transfer({}, { fromPaneKey: PANE_KEY, toPaneKey: CHILD_PANE_KEY })
    canTransferPaneAuthority.mockReturnValue(true)
    transfer({}, { fromPaneKey: PANE_KEY, toPaneKey: CHILD_PANE_KEY, ptyId: 'x'.repeat(513) })
    transfer(
      {},
      {
        fromPaneKey: `${'x'.repeat(180)}:11111111-1111-4111-8111-111111111111`,
        toPaneKey: CHILD_PANE_KEY,
        ptyId: 'pty-1'
      }
    )

    expect(transferPaneAuthority).not.toHaveBeenCalled()
  })
})
