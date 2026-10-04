import { homedir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { OrcaRuntimeService } from '../../orca-runtime'
import { AGENT_LAUNCH_METHODS } from './agent-launch'
import { CAPABLE_CLIENT, methodNamed, STRUCTURED_PREFERENCE } from './agent-launch.test-fixture'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const launch = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')
const selectors = [FLOATING_TERMINAL_WORKTREE_ID, `id:${FLOATING_TERMINAL_WORKTREE_ID}`]

afterEach(() => vi.restoreAllMocks())

describe('agent.launch with the real floating workspace resolver', () => {
  it.each(selectors)('resolves %s without a managed worktree record', async (selector) => {
    const runtime = new OrcaRuntimeService()

    await expect(runtime.showManagedTerminalWorkspace(selector)).rejects.toThrow(
      'selector_not_found'
    )
    await expect(runtime.showTerminalWorkspaceLaunchScope(selector)).resolves.toEqual({
      id: FLOATING_TERMINAL_WORKTREE_ID,
      path: homedir(),
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
  })

  describe.each([true, false])('structured preference %s', (structuredPreference) => {
    it.each(selectors)('launches a terminal through %s', async (selector) => {
      const runtime = new OrcaRuntimeService()
      vi.spyOn(runtime, 'getClientSettings').mockReturnValue(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch reads only these preferences and optional agentCmdOverrides; no other settings consumer runs because terminal creation is stubbed.
        {
          ...STRUCTURED_PREFERENCE,
          openAgentTabsInChatByDefault: structuredPreference
        } as ReturnType<OrcaRuntimeService['getClientSettings']>
      )
      const scope = vi.spyOn(runtime, 'showTerminalWorkspaceLaunchScope')
      const createSupport = vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport')
      const structuredHost = vi.spyOn(runtime, 'ensureStructuredAgentSessionHost')
      const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
        handle: 'term_floating',
        tabId: 'tab_floating',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        title: 'Claude',
        surface: 'background'
      })

      const result = await launch.handler(
        launch.params.parse({ agent: 'claude', target: { kind: 'existing', worktree: selector } }),
        { runtime, ...CAPABLE_CLIENT }
      )

      expect(scope).toHaveBeenCalledExactlyOnceWith(selector)
      expect(createSupport).not.toHaveBeenCalled()
      expect(structuredHost).not.toHaveBeenCalled()
      expect(createTerminal).toHaveBeenCalledExactlyOnceWith(
        `id:${FLOATING_TERMINAL_WORKTREE_ID}`,
        { startupAgent: 'claude', onPtySpawnDispatched: expect.any(Function) }
      )
      expect(result).toMatchObject({
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        outcome: { kind: 'terminal', handle: 'term_floating' },
        receipt: {
          mode: 'terminal',
          reason: structuredPreference ? 'structured_unsupported_on_host' : 'user_default'
        }
      })
    })
  })
})
