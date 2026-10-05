import { describe, expect, it, vi } from 'vitest'
import { decodeHookResumeSession } from '../../shared/agent-resume-identity'
import { OrcaRuntimeService } from './orca-runtime'
import type { RpcRequest, RpcResponse } from './rpc/core'
import { RpcDispatcher } from './rpc/dispatcher'
import { AGENT_SESSION_METHODS } from './rpc/methods/agent-session'

const SESSION_ID = '0195f2ce-1111-4000-8000-000000000001'

function createRuntime() {
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ensureAgentSession reads only getSettings from the store.
    {
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: { codex: '--codex-host-default' },
        agentDefaultEnv: { codex: { CODEX_HOST_DEFAULT: '1' } }
      })
    } as never
  )
  Object.assign(runtime, {
    resolveTerminalWorkspaceLaunchScope: vi.fn(async () => ({
      id: 'worktree-1',
      path: '/tmp/worktree-1',
      connectionId: null
    }))
  })
  const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
    handle: 'term_1',
    tabId: '11111111-1111-4111-8111-111111111111',
    paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
    ptyId: 'pty-1',
    worktreeId: 'worktree-1',
    title: null,
    surface: 'background'
  })
  const dispatcher = new RpcDispatcher({ runtime, methods: AGENT_SESSION_METHODS })
  return { createTerminal, dispatcher }
}

async function ensure(dispatcher: RpcDispatcher, params: unknown): Promise<RpcResponse> {
  const request: RpcRequest = {
    id: 'request-1',
    authToken: 'token',
    method: 'terminal.ensureAgentSession',
    params
  }
  return dispatcher.dispatch(request)
}

// The params an older paired client sends on a sleeping wake: it mirrors the host's session.tabs
// providerSession verbatim into its record and spreads it into the request unchanged
// (remote-runtime-pty-transport.ts on origin/main, `providerSession: resumeProviderSessionToSend`).
function olderClientWake(displayAgent: string, routeSource: string, extra = {}) {
  return {
    kind: 'explicit',
    worktree: 'id:worktree-1',
    agent: displayAgent,
    providerSession: decodeHookResumeSession(
      { key: 'session_id', id: SESSION_ID },
      routeSource,
      null
    ),
    placement: { tabId: 'tab-1', leafId: 'leaf-1' },
    presentation: 'background',
    ...extra
  }
}

describe('terminal.ensureAgentSession from a client that echoes the host owner label', () => {
  it('accepts the label and resumes the same session a current client would', async () => {
    const { createTerminal, dispatcher } = createRuntime()

    const older = await ensure(dispatcher, olderClientWake('claude', 'claude'))
    const current = await ensure(dispatcher, {
      ...olderClientWake('claude', 'claude'),
      providerSession: { key: 'session_id', id: SESSION_ID }
    })

    expect(older).toMatchObject({ ok: true })
    expect(current).toMatchObject({ ok: true })
    const [olderLaunch, currentLaunch] = createTerminal.mock.calls.map((call) => call[1])
    expect(olderLaunch).toMatchObject({
      launchAgent: 'claude',
      command: expect.stringMatching(new RegExp(`^claude .*'--resume' '${SESSION_ID}'$`))
    })
    expect(olderLaunch?.agentSessionClaim).toEqual(currentLaunch?.agentSessionClaim)
  })

  it('resumes a mixed label with its owner and the host defaults, not the other agent settings', async () => {
    const { createTerminal, dispatcher } = createRuntime()

    const older = await ensure(
      dispatcher,
      olderClientWake('claude', 'codex', {
        agentArgs: '--claude-only',
        launchPreferences: { model: 'claude-model' }
      })
    )
    const current = await ensure(dispatcher, {
      ...olderClientWake('codex', 'codex'),
      providerSession: { key: 'session_id', id: SESSION_ID }
    })

    expect(older).toMatchObject({ ok: true })
    expect(current).toMatchObject({ ok: true })
    const [olderLaunch, currentLaunch] = createTerminal.mock.calls.map((call) => call[1])
    expect(olderLaunch).toMatchObject({
      launchAgent: 'codex',
      command: `codex '--codex-host-default' 'resume' '${SESSION_ID}'`,
      env: expect.objectContaining({ CODEX_HOST_DEFAULT: '1' })
    })
    expect(olderLaunch?.command).not.toContain('claude')
    expect(olderLaunch?.agentSessionClaim).toEqual(currentLaunch?.agentSessionClaim)
  })

  it('resolves an unlabelled session saved before the label from its own transcript path', async () => {
    const { createTerminal, dispatcher } = createRuntime()
    const transcriptPath = `/Users/example/.codex/sessions/2026/09/30/rollout-2026-09-30T00-00-00-${SESSION_ID}.jsonl`
    const locator = { key: 'session_id', id: SESSION_ID, transcriptPath }

    const older = await ensure(dispatcher, {
      ...olderClientWake('claude', 'claude', { agentArgs: '--claude-only' }),
      providerSession: locator
    })
    const current = await ensure(dispatcher, {
      ...olderClientWake('codex', 'codex'),
      providerSession: locator
    })

    expect(older).toMatchObject({ ok: true })
    expect(current).toMatchObject({ ok: true })
    const [olderLaunch, currentLaunch] = createTerminal.mock.calls.map((call) => call[1])
    expect(olderLaunch).toMatchObject({
      launchAgent: 'codex',
      command: `codex '--codex-host-default' 'resume' '${SESSION_ID}'`
    })
    expect(olderLaunch?.agentSessionClaim).toEqual(currentLaunch?.agentSessionClaim)
  })

  it('keeps every other provider-session field strict', async () => {
    const { createTerminal, dispatcher } = createRuntime()

    const response = await ensure(dispatcher, {
      ...olderClientWake('claude', 'claude'),
      providerSession: { key: 'session_id', id: SESSION_ID, unexpected: true }
    })

    expect(response).toMatchObject({ ok: false })
    expect(createTerminal).not.toHaveBeenCalled()
  })
})
