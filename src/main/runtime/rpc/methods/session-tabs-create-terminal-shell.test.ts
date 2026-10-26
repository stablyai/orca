import '../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import { SESSION_TABS_CREATE_TERMINAL_SHELL_RUNTIME_CAPABILITY } from '../../../../shared/session-tabs-runtime-capabilities'
import { SESSION_TAB_METHODS } from './session-tabs'
import { TERMINAL_SEND_METHODS } from './terminal/terminal-send-method'
import {
  installOwnership,
  PROVIDER_SESSION
} from '../../../ai-vault/structured-session-ownership.test-support'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { agentSessionLeaseFixture } from '../../../../shared/agent-session-record.test-fixture'

function makeRequest(params: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method: 'session.tabs.createTerminal', params }
}

function makeRuntime(): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only calls these two members.
  return {
    getRuntimeId: () => 'test-runtime',
    ensureStructuredAgentSessionHost: vi.fn(async () => undefined),
    createMobileSessionTerminal: vi.fn().mockResolvedValue({
      tab: { type: 'terminal', id: 'tab-1::leaf-1' },
      publicationEpoch: 'epoch-1',
      snapshotVersion: 1
    })
  } as unknown as OrcaRuntimeService
}

describe('session.tabs.createTerminal shell selection', () => {
  afterEach(() => setStructuredAgentSessionHost(null))

  it.each([
    { agent: 'claude', proving: false, code: 'agent_session_conflict' },
    { agent: 'codex', proving: true, code: 'agent_session_ownership_unknown' }
  ] as const)(
    'preserves the terminal.send writer refusal for typed $agent resume',
    async ({ agent, proving, code }) => {
      const runtime = makeRuntime()
      vi.mocked(runtime.ensureStructuredAgentSessionHost).mockImplementation(async () => {
        installOwnership({
          provider: agent,
          lease: agentSessionLeaseFixture(
            proving
              ? { handoffStage: 'new-owner-proving', claimStatus: 'reserved', ownerProcess: null }
              : {}
          )
        })
      })
      const dispatcher = new RpcDispatcher({
        runtime,
        methods: [...SESSION_TAB_METHODS, ...TERMINAL_SEND_METHODS]
      })
      const oldReply = await dispatcher.dispatch({
        id: 'old-send',
        authToken: 'tok',
        method: 'terminal.send',
        params: {
          terminal: 'terminal-1',
          text:
            agent === 'claude'
              ? `claude --resume ${PROVIDER_SESSION}`
              : `codex resume ${PROVIDER_SESSION}`,
          enter: true
        }
      })
      setStructuredAgentSessionHost(null)
      const typedReply = await dispatcher.dispatch(
        makeRequest({
          worktree: 'id:wt-1',
          clientMutationId: 'resume-1',
          launchAgent: agent,
          resume: { recipe: { source: 'current-inputs', settings: {} } },
          resumeProviderSession: { key: 'session_id', id: PROVIDER_SESSION }
        })
      )
      expect(oldReply).toMatchObject({ ok: false, error: { code } })
      expect(typedReply).toMatchObject({ ok: false, error: { code } })
      expect(runtime.createMobileSessionTerminal).not.toHaveBeenCalled()
      expect(runtime.ensureStructuredAgentSessionHost).toHaveBeenCalledTimes(2)
    }
  )

  it('advertises shell selection so clients stop typing the shell into the default one', () => {
    expect(RUNTIME_CAPABILITIES).toContain(SESSION_TABS_CREATE_TERMINAL_SHELL_RUNTIME_CAPABILITY)
  })

  it('creates the requested shell instead of a startup command', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(makeRequest({ worktree: 'id:wt-1', shell: 'Cmd' }))

    expect(response.ok).toBe(true)
    const opts = vi.mocked(runtime.createMobileSessionTerminal).mock.calls[0]?.[1]
    expect(opts).toMatchObject({ shellOverride: 'cmd.exe' })
    expect(opts?.command).toBeUndefined()
  })

  it('omits the override when no shell is requested', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await dispatcher.dispatch(makeRequest({ worktree: 'id:wt-1' }))

    const opts = vi.mocked(runtime.createMobileSessionTerminal).mock.calls[0]?.[1]
    expect(opts).not.toHaveProperty('shellOverride')
  })

  it('projects an unowned typed resume and the restricted WSL account contribution through the RPC', async () => {
    installOwnership()
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const resume = { recipe: { source: 'saved' } }
    const accountEnv = { CODEX_HOME: '/home/qa/managed' }
    const request = {
      worktree: 'id:wt-1',
      launchAgent: 'codex',
      resume,
      resumeProviderSession: { key: 'session_id', id: 'saved' },
      accountEnv,
      env: { ORCA_PANE_KEY: 'tab:leaf' },
      viewMode: 'chat'
    }
    expect((await dispatcher.dispatch(makeRequest(request))).ok).toBe(true)
    expect(runtime.createMobileSessionTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ resume, accountEnv, env: request.env, viewMode: 'chat' })
    )
    expect(
      (await dispatcher.dispatch(makeRequest({ ...request, accountEnv: { PATH: '/bad' } }))).ok
    ).toBe(false)
    expect(runtime.createMobileSessionTerminal).toHaveBeenCalledOnce()
  })

  it('refuses a shell pick combined with an agent launch, whose plan picks its own shell', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({ worktree: 'id:wt-1', shell: 'cmd.exe', agent: 'claude' })
    )

    expect(response.ok).toBe(false)
    expect(runtime.createMobileSessionTerminal).not.toHaveBeenCalled()
  })

  it('refuses a shell outside the Windows allowlist before creating a terminal', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(makeRequest({ worktree: 'id:wt-1', shell: 'zsh' }))

    expect(response.ok).toBe(false)
    expect(runtime.createMobileSessionTerminal).not.toHaveBeenCalled()
  })
})
