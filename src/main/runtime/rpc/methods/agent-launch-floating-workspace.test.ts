import { homedir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { ResolvedWorktree } from '../../runtime-worktree-path-identity'
import { AGENT_LAUNCH_METHODS } from './agent-launch'
import { CAPABLE_CLIENT, methodNamed, STRUCTURED_PREFERENCE } from './agent-launch.test-fixture'

const createStructuredSession = vi.hoisted(() =>
  vi.fn(async (args: { envelope: { sessionId: string } }) => ({
    ok: true as const,
    value: { sessionId: args.envelope.sessionId, fence: 1 }
  }))
)

vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: createStructuredSession
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const launch = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')
const selectors = [FLOATING_TERMINAL_WORKTREE_ID, `id:${FLOATING_TERMINAL_WORKTREE_ID}`]

afterEach(() => {
  vi.restoreAllMocks()
  createStructuredSession.mockClear()
})

describe('floating workspace resolved-worktree minting', () => {
  // Regression: this mixin file is @ts-nocheck, so a missing module import there is invisible to
  // `pnpm tc` and only fails at call time (shipped once as a ReferenceError from the structured
  // createSupport path). Calling the real method pins the import wiring.
  it('mints the synthetic floating row through the shared module', () => {
    class FloatingResolverProbe extends OrcaRuntimeService {
      mintFloatingResolvedWorktree(path: string): ResolvedWorktree {
        return this.floatingWorkspaceToResolvedWorktree(path)
      }
    }

    const resolved = new FloatingResolverProbe().mintFloatingResolvedWorktree('/tmp/floating-qa')

    expect(resolved).toMatchObject({
      id: FLOATING_TERMINAL_WORKTREE_ID,
      path: '/tmp/floating-qa',
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: { path: '/tmp/floating-qa', head: '', branch: '', isBare: false, isMainWorktree: false }
    })
  })
})

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

  // Why here: the runtime resolvers this crosses are @ts-nocheck, so only a call that runs them
  // proves the floating workspace resolves to a location a structured session can be filed under.
  it.each(selectors)('supports a structured session for %s on the local host', async (selector) => {
    const runtime = new OrcaRuntimeService()

    await expect(
      runtime.getStructuredAgentSessionCreateSupport(selector, 'codex')
    ).resolves.toEqual({
      supported: true
    })
  })

  describe.each([true, false])('structured preference %s', (structuredPreference) => {
    it.each(selectors)('routes %s by preference, not by workspace kind', async (selector) => {
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
        launch.params.parse({ agent: 'codex', target: { kind: 'existing', worktree: selector } }),
        { runtime, ...CAPABLE_CLIENT }
      )

      expect(scope).toHaveBeenCalledExactlyOnceWith(selector)
      if (structuredPreference) {
        expect(createSupport).toHaveBeenCalledWith(`id:${FLOATING_TERMINAL_WORKTREE_ID}`, 'codex')
        expect(createStructuredSession).toHaveBeenCalledWith(
          expect.objectContaining({ worktree: `id:${FLOATING_TERMINAL_WORKTREE_ID}` })
        )
        expect(createTerminal).not.toHaveBeenCalled()
        expect(result).toMatchObject({
          worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
          outcome: { kind: 'structured', sessionId: expect.any(String) },
          receipt: { mode: 'structured' }
        })
      } else {
        expect(createStructuredSession).not.toHaveBeenCalled()
        expect(createSupport).not.toHaveBeenCalled()
        expect(structuredHost).not.toHaveBeenCalled()
        expect(createTerminal).toHaveBeenCalledExactlyOnceWith(
          `id:${FLOATING_TERMINAL_WORKTREE_ID}`,
          { startupAgent: 'codex' }
        )
        expect(result).toMatchObject({
          worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
          outcome: { kind: 'terminal', handle: 'term_floating' },
          receipt: { mode: 'terminal', reason: 'user_default' }
        })
      }
    })
  })
})
