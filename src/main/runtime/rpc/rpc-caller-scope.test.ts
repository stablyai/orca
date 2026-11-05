import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest, RpcResponse } from './core'
import { RpcDispatcher } from './dispatcher'
import type { RpcCallerScope } from './rpc-caller-scope'

const PAIRED: RpcCallerScope = { kind: 'runtime-paired', grants: [] }

function request(method: string, params?: unknown): RpcRequest {
  return { id: `req-${method}`, authToken: 'unused', method, params }
}

async function dispatchAs(
  scope: RpcCallerScope | undefined,
  method: string,
  params?: unknown,
  runtime = new OrcaRuntimeService()
): Promise<RpcResponse> {
  return new RpcDispatcher({ runtime }).dispatch(
    request(method, params),
    scope ? { callerScope: scope } : undefined
  )
}

function errorCode(response: RpcResponse): string | null {
  return response.ok ? null : response.error.code
}

describe('paired runtime clients', () => {
  it('cannot drive the desktop without a pairing-time grant', async () => {
    const response = await dispatchAs(PAIRED, 'computer.click', { app: 'Finder' })
    expect(errorCode(response)).toBe('forbidden')
  })

  it.each(['pairing.provisionRelay', 'pairing.getEndpoints', 'notifications.registerPush'])(
    'are refused pairing and push administration: %s',
    async (method) => {
      const response = await dispatchAs(PAIRED, method, {})
      expect(errorCode(response)).toBe('forbidden')
    }
  )

  it('learn an unregistered method is missing rather than forbidden', async () => {
    const response = await dispatchAs(PAIRED, 'computer.methodFromTheFuture', {})
    expect(errorCode(response)).toBe('method_not_found')
  })
})

describe('a pinned in-process bridge dispatcher', () => {
  it('ignores a wider per-call scope', async () => {
    const dispatcher = new RpcDispatcher({
      runtime: new OrcaRuntimeService(),
      callerScope: PAIRED
    })
    const response = await dispatcher.dispatch(request('computer.click', { app: 'Finder' }), {
      callerScope: { kind: 'owner' }
    })
    expect(errorCode(response)).toBe('forbidden')
  })
})
