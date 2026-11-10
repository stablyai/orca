import { describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { SecretRequestStore } from '../../../secrets/secret-request-store'
import type { RpcContext, RpcMethod } from '../../core'
import { eraseRpcMethods } from '../../core'
import { createSecretRequestMethods } from './secret-requests'

/** `verified` stands in for the terminal orcad attests from launch evidence. */
function setup(
  options: { sessionEnv?: string[]; enabled?: boolean; verified?: string | null } = {}
) {
  let seq = 0
  const store = new SecretRequestStore(Date.now, () => `sr_rpc${String(++seq).padStart(5, '0')}`)
  const methods = new Map<string, RpcMethod>(
    eraseRpcMethods(
      createSecretRequestMethods({
        store: () => store,
        sessionEnvNames: async () => new Set(options.sessionEnv ?? []),
        enabled: () => options.enabled ?? true,
        callerTerminal: (ctx) =>
          ctx.caller?.kind === 'local-cli' ? (options.verified ?? null) : null
      })
    ).map((method) => [method.name, method])
  )
  const terminals: Record<string, { agent: string | null; worktreeId: string }> = {
    'term-codex': { agent: 'codex', worktreeId: 'wt-real' }
  }
  const fake = {
    getTerminalHandleAgent: (handle: string) => terminals[handle] ?? null,
    isKnownWorktree: async (id: string) => id === 'wt-known'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read only these members.
  const runtime = fake as unknown as OrcaRuntimeService
  const call = async (name: string, params: unknown, ctx: Partial<RpcContext> = {}) => {
    const method = methods.get(name)
    if (!method) {
      throw new Error(`${name} is not registered`)
    }
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, { runtime, ...ctx })
  }
  const events: unknown[] = []
  store.subscribe((event) => events.push(event))
  return { call, events }
}

const desktop: Partial<RpcContext> = { caller: { kind: 'paired-device', deviceId: 'dev-1' } }
const agentCli: Partial<RpcContext> = { caller: { kind: 'local-cli' } }

describe('secrets.* RPC', () => {
  it('derives the agent and worktree from the verified calling terminal', async () => {
    const { call, events } = setup({ verified: 'term-codex' })
    await expect(
      call(
        'secrets.request',
        { name: 'STRIPE_KEY', reason: 'tests', worktreeId: 'wt-known' },
        agentCli
      )
    ).resolves.toEqual({ requestId: 'sr_rpc00001', status: 'pending' })
    expect(events[0]).toMatchObject({
      agent: 'codex',
      worktreeId: 'wt-real',
      terminalHandle: 'term-codex'
    })
  })

  it('takes no terminal or agent from params', async () => {
    const { call } = setup()
    for (const extra of [{ terminalHandle: 'term-codex' }, { agent: 'claude' }]) {
      await expect(
        call('secrets.request', { name: 'A', reason: 'r', ...extra }, agentCli)
      ).rejects.toThrow()
    }
  })

  it('without a verified terminal: agent unknown, worktree hint kept only if this host knows it', async () => {
    const { call, events } = setup({ verified: null })
    await call('secrets.request', { name: 'A', reason: 'r', worktreeId: 'wt-known' }, agentCli)
    await call('secrets.request', { name: 'B', reason: 'r', worktreeId: 'wt-made-up' }, agentCli)
    expect(events[0]).toMatchObject({ agent: null, worktreeId: 'wt-known' })
    expect(events[0]).not.toHaveProperty('terminalHandle')
    expect(events[1]).toMatchObject({ agent: null, worktreeId: null })
  })

  it('refuses every method outside a cloud workspace orcad', async () => {
    const { call } = setup({ enabled: false })
    await expect(call('secrets.request', { name: 'A', reason: 'r' })).rejects.toThrow(
      'secret_requests_unavailable'
    )
    await expect(
      call('secrets.requestStatus', { requestId: 'sr_rpc00001' }, desktop)
    ).rejects.toThrow('secret_requests_unavailable')
  })

  it('answers already-set from the session env and refuses agent credentials', async () => {
    const { call } = setup({ sessionEnv: ['SENTRY_DSN'] })
    await expect(call('secrets.request', { name: 'SENTRY_DSN', reason: 'r' })).resolves.toEqual({
      requestId: null,
      status: 'already-set'
    })
    await expect(
      call('secrets.request', { name: 'ANTHROPIC_API_KEY', reason: 'r' })
    ).rejects.toThrow('use_sign_in_or_cloud_secrets')
  })

  it('strips control and bidi characters from the reason, and caps it at 200 characters', async () => {
    const { call, events } = setup()
    await call('secrets.request', {
      name: 'A',
      reason: 'Run‮ the\ntests\u0007 ⁦now⁩\u001b[31m'
    })
    expect(events[0]).toMatchObject({ reason: 'Run the tests now [31m' })
    await expect(call('secrets.request', { name: 'B', reason: 'x'.repeat(201) })).rejects.toThrow()
    await expect(call('secrets.request', { name: 'C', reason: '‮\n\u0000' })).rejects.toThrow()
  })

  it('lets a person, never the agent CLI, touch and resolve; anyone reads status', async () => {
    const { call } = setup()
    await call('secrets.request', { name: 'A', reason: 'r' }, agentCli)
    const id = { requestId: 'sr_rpc00001' }
    await expect(call('secrets.touchRequest', id, agentCli)).rejects.toThrow(
      'secret_request_forbidden'
    )
    await expect(
      call('secrets.resolveRequest', { ...id, outcome: 'provided' }, agentCli)
    ).rejects.toThrow('secret_request_forbidden')
    await expect(call('secrets.touchRequest', id, desktop)).resolves.toHaveProperty('expiresAt')
    await expect(
      call('secrets.resolveRequest', { ...id, outcome: 'provided' }, desktop)
    ).resolves.toEqual({ outcome: 'provided' })
    await expect(call('secrets.requestStatus', id, agentCli)).resolves.toMatchObject({
      status: 'provided',
      name: 'A'
    })
  })
})
