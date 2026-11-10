import { describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { SecretRequestStore } from '../../../secrets/secret-request-store'
import type { RpcContext, RpcMethod } from '../../core'
import { eraseRpcMethods } from '../../core'
import { createSecretRequestMethods } from './secret-requests'

function setup(sessionEnv: string[] = []) {
  let seq = 0
  const store = new SecretRequestStore(Date.now, () => `sr_rpc${String(++seq).padStart(5, '0')}`)
  const methods = new Map<string, RpcMethod>(
    eraseRpcMethods(
      createSecretRequestMethods({
        store: () => store,
        sessionEnvNames: async () => new Set(sessionEnv)
      })
    ).map((method) => [method.name, method])
  )
  const terminals: Record<string, { agent: string | null; worktreeId: string }> = {
    'term-codex': { agent: 'codex', worktreeId: 'wt-real' }
  }
  const fake = { getTerminalHandleAgent: (handle: string) => terminals[handle] ?? null }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read only getTerminalHandleAgent.
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
  it('derives the agent and worktree from the calling terminal, not from params', async () => {
    const { call, events } = setup()
    await expect(
      call(
        'secrets.request',
        {
          name: 'STRIPE_KEY',
          reason: 'tests',
          terminalHandle: 'term-codex',
          worktreeId: 'wt-hint'
        },
        agentCli
      )
    ).resolves.toEqual({ requestId: 'sr_rpc00001', status: 'pending' })
    expect(events[0]).toMatchObject({
      agent: 'codex',
      worktreeId: 'wt-real',
      terminalHandle: 'term-codex'
    })
  })

  it('leaves the agent unknown for an unrecognized terminal and refuses a caller-named agent', async () => {
    const { call, events } = setup()
    await call(
      'secrets.request',
      { name: 'A', reason: 'r', terminalHandle: 'forged', worktreeId: 'wt-hint' },
      agentCli
    )
    expect(events[0]).toMatchObject({ agent: null, worktreeId: 'wt-hint' })
    expect(events[0]).not.toHaveProperty('terminalHandle')
    await expect(
      call('secrets.request', { name: 'B', reason: 'r', agent: 'claude' }, agentCli)
    ).rejects.toThrow()
  })

  it('answers already-set from the session env and refuses agent credentials', async () => {
    const { call } = setup(['SENTRY_DSN'])
    await expect(call('secrets.request', { name: 'SENTRY_DSN', reason: 'r' })).resolves.toEqual({
      requestId: null,
      status: 'already-set'
    })
    await expect(
      call('secrets.request', { name: 'ANTHROPIC_API_KEY', reason: 'r' })
    ).rejects.toThrow('use_sign_in_or_cloud_secrets')
  })

  it('rejects a reason over 200 characters', async () => {
    const { call } = setup()
    await expect(call('secrets.request', { name: 'A', reason: 'x'.repeat(201) })).rejects.toThrow()
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
