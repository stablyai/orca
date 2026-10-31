import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { RpcDispatcher } from './dispatcher'
import { defineMethod, defineStreamingMethod, type RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { ensureAgentSessionFeatureRequirement } from './agent-launch-feature-requirement'
import {
  _resetOrcadFeatureReadinessForTests,
  installOrcadFeatureReadiness,
  ORCAD_FEATURE_WAIT_MS
} from './orcad-feature-readiness'

const request = (method: string, params: unknown = {}): RpcRequest => ({
  id: 'r1',
  authToken: 't',
  method,
  params
})

function dispatcher(): { dispatcher: RpcDispatcher; ran: string[] } {
  const ran: string[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reads only these runtime members for plain methods.
  const runtime = {
    getRuntimeId: () => 'rt',
    recordFeatureInteraction: vi.fn()
  } as unknown as OrcaRuntimeService
  const methods = [
    defineMethod({
      name: 'aiVault.searchStatus',
      requires: ['sessionSearch'],
      permission: 'workspace',
      params: z.object({}),
      handler: () => {
        ran.push('searchStatus')
        return { ready: true }
      }
    }),
    defineMethod({
      name: 'status.get',
      permission: 'workspace',
      params: z.object({}),
      handler: () => {
        ran.push('status')
        return {}
      }
    }),
    defineMethod({
      name: 'terminal.create',
      requires: (params) => (params.command === 'claude' ? ['accounts'] : []),
      permission: 'workspace',
      params: z.object({ command: z.string().optional() }),
      handler: (params) => {
        ran.push(`create ${params.command ?? 'shell'}`)
        return {}
      }
    }),
    defineMethod({
      name: 'terminal.ensureAgentSession',
      requires: ensureAgentSessionFeatureRequirement,
      permission: 'workspace',
      params: z.object({ kind: z.enum(['automatic', 'explicit']) }),
      handler: (params) => {
        ran.push(`ensure ${params.kind}`)
        return {}
      }
    }),
    defineStreamingMethod({
      name: 'accounts.subscribe',
      requires: ['accounts'],
      permission: 'workspace',
      params: z.object({}),
      handler: async (_params, _ctx, emit) => {
        ran.push('subscribe')
        emit({ type: 'ready' })
      }
    })
  ]
  return { dispatcher: new RpcDispatcher({ runtime, methods }), ran }
}

afterEach(() => {
  _resetOrcadFeatureReadinessForTests()
  vi.useRealTimers()
})

describe('RPC methods that require an orcad startup phase', () => {
  it('run at once where no readiness is installed (the desktop)', async () => {
    const { dispatcher: rpc, ran } = dispatcher()
    await expect(rpc.dispatch(request('aiVault.searchStatus'))).resolves.toMatchObject({ ok: true })
    expect(ran).toEqual(['searchStatus'])
  })

  it('wait for their phase, while methods that need none run at once', async () => {
    const readiness = installOrcadFeatureReadiness()
    const { dispatcher: rpc, ran } = dispatcher()
    const search = rpc.dispatch(request('aiVault.searchStatus'))
    await expect(rpc.dispatch(request('status.get'))).resolves.toMatchObject({ ok: true })
    expect(ran).toEqual(['status'])

    readiness.open('sessionSearch')
    await expect(search).resolves.toMatchObject({ ok: true, result: { ready: true } })
    expect(ran).toEqual(['status', 'searchStatus'])
  })

  it('refuse retryably with runtime_unavailable once the bounded wait runs out', async () => {
    vi.useFakeTimers()
    installOrcadFeatureReadiness()
    const { dispatcher: rpc, ran } = dispatcher()
    const search = rpc.dispatch(request('aiVault.searchStatus'))
    await vi.advanceTimersByTimeAsync(ORCAD_FEATURE_WAIT_MS)
    await expect(search).resolves.toMatchObject({
      ok: false,
      error: { code: 'runtime_unavailable' }
    })
    expect(ran).toEqual([])
  })

  it('gate streaming methods the same way', async () => {
    const readiness = installOrcadFeatureReadiness()
    const { dispatcher: rpc, ran } = dispatcher()
    const replies: string[] = []
    const stream = rpc.dispatchStreaming(request('accounts.subscribe'), (reply) =>
      replies.push(reply)
    )
    await Promise.resolve()
    expect(ran).toEqual([])
    readiness.open('accounts')
    await stream
    expect(ran).toEqual(['subscribe'])
    expect(replies).toHaveLength(1)
  })

  it('gate a terminal create only when its params start an agent', async () => {
    const readiness = installOrcadFeatureReadiness()
    const { dispatcher: rpc, ran } = dispatcher()
    const agent = rpc.dispatch(request('terminal.create', { command: 'claude' }))
    await expect(rpc.dispatch(request('terminal.create', {}))).resolves.toMatchObject({ ok: true })
    expect(ran).toEqual(['create shell'])
    readiness.open('accounts')
    await expect(agent).resolves.toMatchObject({ ok: true })
    expect(ran).toEqual(['create shell', 'create claude'])
  })

  // A handler run for a caller that left leaks its close cleanup, or runs a retried mutation twice.
  it('refuse a unary call whose request is aborted while it waits, never running it', async () => {
    vi.useFakeTimers()
    const readiness = installOrcadFeatureReadiness()
    const { dispatcher: rpc, ran } = dispatcher()
    const aborted = new AbortController()
    let reply: unknown = 'pending'
    void rpc.dispatch(request('aiVault.searchStatus'), { signal: aborted.signal }).then((r) => {
      reply = r
    })
    await vi.advanceTimersByTimeAsync(1)
    aborted.abort()
    await vi.advanceTimersByTimeAsync(1)
    expect(reply).toMatchObject({ ok: false, error: { code: 'runtime_unavailable' } })
    readiness.open('sessionSearch')
    await vi.advanceTimersByTimeAsync(1)
    expect(ran).toEqual([])
  })

  it('refuse a stream whose connection closes while it waits, never running its handler', async () => {
    vi.useFakeTimers()
    const readiness = installOrcadFeatureReadiness()
    const { dispatcher: rpc, ran } = dispatcher()
    const closed = new AbortController()
    const replies: string[] = []
    void rpc.dispatchStreaming(request('accounts.subscribe'), (reply) => replies.push(reply), {
      connectionSignal: closed.signal
    })
    await vi.advanceTimersByTimeAsync(1)
    closed.abort()
    await vi.advanceTimersByTimeAsync(1)
    expect(replies.map((reply) => JSON.parse(reply))).toMatchObject([
      { ok: false, error: { code: 'runtime_unavailable' } }
    ])
    readiness.open('accounts')
    await vi.advanceTimersByTimeAsync(1)
    expect(ran).toEqual([])
  })

  it('refuse at once when the caller already left, without waiting out the bound', async () => {
    vi.useFakeTimers()
    installOrcadFeatureReadiness()
    const { dispatcher: rpc, ran } = dispatcher()
    let reply: unknown = 'pending'
    void rpc
      .dispatch(request('aiVault.searchStatus'), { connectionSignal: AbortSignal.abort() })
      .then((r) => {
        reply = r
      })
    await vi.advanceTimersByTimeAsync(1)
    expect(reply).toMatchObject({ ok: false, error: { code: 'runtime_unavailable' } })
    expect(ran).toEqual([])
  })

  it('run an attach-only ensureAgentSession at once while every latch is closed', async () => {
    const readiness = installOrcadFeatureReadiness()
    const { dispatcher: rpc, ran } = dispatcher()
    const explicit = rpc.dispatch(request('terminal.ensureAgentSession', { kind: 'explicit' }))
    await expect(
      rpc.dispatch(request('terminal.ensureAgentSession', { kind: 'automatic' }))
    ).resolves.toMatchObject({ ok: true })
    expect(ran).toEqual(['ensure automatic'])
    readiness.open('accounts')
    await expect(explicit).resolves.toMatchObject({ ok: true })
    expect(ran).toEqual(['ensure automatic', 'ensure explicit'])
  })
})
