/**
 * `--model`/`--effort` used to downgrade a structured-preferring worker to a PTY terminal because
 * "launch preferences apply only to a terminal agent". They no longer do: the same two ids a saved
 * selection seeds a chat with are seeded into the worker's own session here.
 */

import { describe, expect, it, vi } from 'vitest'

const createStructuredWorkerSession = vi.fn(async (_args: Record<string, unknown>) => ({
  identity: { handle: 'structworker_1', sessionId: 'sess_1' },
  host: {}
}))

vi.mock('../../orchestration-structured-worker-session', () => ({
  createStructuredWorkerSession: (args: never) => createStructuredWorkerSession(args)
}))

const { createStructuredWorkerSessionForWorktree } = await import('./worker-topology')
const { prepareStructuredAgentSessionCreateForWorktree } =
  await import('../../structured-agent-session-create')

async function createWith(launchPreferences?: Record<string, string>) {
  createStructuredWorkerSession.mockClear()
  await createStructuredWorkerSessionForWorktree({
    runtime: {} as never,
    worktreeId: 'repo::wt',
    agent: 'codex',
    dispatchId: 'ctx_1',
    ...(launchPreferences ? { launchPreferences } : {}),
    effects: []
  })
  return createStructuredWorkerSession.mock.calls[0]?.[0] ?? {}
}

describe('a structured worker seeds the dispatch launch preferences', () => {
  it('carries --model and --effort into the session create', async () => {
    expect(await createWith({ model: 'gpt-5.6-sol', effort: 'high' })).toMatchObject({
      options: { model: 'gpt-5.6-sol', effort: 'high' }
    })
  })

  it('carries only the model when no --effort was asked for', async () => {
    expect((await createWith({ model: 'gpt-5.6-sol' })).options).toEqual({ model: 'gpt-5.6-sol' })
  })

  it.each([
    ['no preferences at all', undefined],
    ['an option set that narrows to nothing', { model: '  ' }]
  ])('omits options entirely for %s, never sending {}', async (_name, preferences) => {
    // `{}` fails the durable record's bounded-string guard, and `agent_session_options_invalid` is
    // not a wire refusal code — the throw strands the launch with no fallback. Omitted, the host
    // seeds the user's own saved selection instead, which is what a chat would get.
    expect(await createWith(preferences)).not.toHaveProperty('options')
  })
})

describe('the create the seed options land in', () => {
  const settingsResolved = {
    location: { executionHostId: 'local', wslDistro: null, workspaceId: 'repo::wt' },
    provider: 'codex',
    agent: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/host/.codex' },
    runtimeKind: 'native',
    options: { model: 'saved-model', effort: 'low' }
  }

  async function prepare(options?: Record<string, string>) {
    const prepared = await prepareStructuredAgentSessionCreateForWorktree({
      runtime: {
        resolveStructuredAgentSessionCreateIntent: async () => settingsResolved
      } as never,
      ensureHost: async () => ({}) as never,
      envelope: {
        sessionId: 'sess_1',
        clientOperationId: 'op_1',
        expectedRuntimeFence: null,
        payloadFingerprint: ''
      },
      worktree: 'id:repo::wt',
      agent: 'codex',
      caller: { callerKey: 'orchestration:dispatch:ctx_1' },
      ...(options ? { options } : {})
    })
    return prepared.attachParams
  }

  it("replaces the saved selection the host resolved with the dispatch's own", async () => {
    expect((await prepare({ model: 'gpt-5.6-sol', effort: 'high' })).options).toEqual({
      model: 'gpt-5.6-sol',
      effort: 'high'
    })
  })

  it('keeps the saved selection when the dispatch named none', async () => {
    expect((await prepare()).options).toEqual({ model: 'saved-model', effort: 'low' })
  })

  it('does not let the seed options move the attach fingerprint', async () => {
    // Options are the session's initial state, not its identity: a retry re-resolves them and must
    // replay rather than conflict.
    const [seeded, unseeded] = await Promise.all([prepare({ model: 'gpt-5.6-sol' }), prepare()])
    expect(seeded.envelope.payloadFingerprint).toBe(unseeded.envelope.payloadFingerprint)
  })
})
