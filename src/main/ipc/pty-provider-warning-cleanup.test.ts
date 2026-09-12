import { describe, expect, it, vi } from 'vitest'
import { createPtyIpcSession } from './pty/session'
import { wirePtyIpcSession } from './pty/delivery/wire-session'
import { clearProviderPtyState } from './pty/provider/state-cleanup'
import { dropOversizedPendingPtyData, pendingDataCapChars } from './pty/delivery/pending'

vi.mock('./pty/provider/registry', () => ({ tryGetProviderForPty: () => null }))
vi.mock('../ports/advertised-url-watcher', () => ({ advertisedUrlWatcher: { unbindPty: vi.fn() } }))
vi.mock('../memory/pty-registry', () => ({ unregisterPty: vi.fn() }))
vi.mock('../claude-accounts/live-pty-gate', () => ({ markClaudePtyExited: vi.fn() }))
vi.mock('../codex/codex-pane-account-registry', () => ({ forgetCodexPaneAccount: vi.fn() }))
vi.mock('../opencode/hook-service', () => ({ openCodeHookService: { clearPty: vi.fn() } }))
vi.mock('../pi/titlebar-extension-service', () => ({
  piTitlebarExtensionService: { clearPty: vi.fn() }
}))
vi.mock('../agent-hooks/server', () => ({
  agentHookServer: { clearPaneKeyAliasesForPty: vi.fn(), clearPaneState: vi.fn() }
}))

describe('provider teardown warning retirement', () => {
  it.each([false, true])(
    'releases early-output warning state without a renderer exit; preserve SSH owners=%s',
    (preserveAgentSessionOwners) => {
      const send = vi.fn()
      const session = createPtyIpcSession({
        mainWindow: { isDestroyed: () => false, webContents: { send } } as never
      })
      wirePtyIpcSession(session)
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const oversized = { data: 'x'.repeat(pendingDataCapChars(session) + 1) }
        dropOversizedPendingPtyData(session, 'spawn-failed', oversized)
        dropOversizedPendingPtyData(session, 'active-sibling', oversized)
        expect(error).toHaveBeenCalledTimes(2)
        clearProviderPtyState('spawn-failed', { preserveAgentSessionOwners })
        expect([...session.pendingDataDropWarnedPtys]).toEqual(['active-sibling'])
        expect(send).not.toHaveBeenCalled()
        dropOversizedPendingPtyData(session, 'spawn-failed', oversized)
        expect(error).toHaveBeenCalledTimes(3)
      } finally {
        error.mockRestore()
        clearProviderPtyState('spawn-failed', { preserveAgentSessionOwners: true })
        clearProviderPtyState('active-sibling', { preserveAgentSessionOwners: true })
      }
    }
  )
})
