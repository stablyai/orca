import { describe, expect, it } from 'vitest'
import { MANAGED_SERVER_RUNTIME_CAPABILITY } from '../../shared/remote-runtime/protocol/host-runtime-capabilities'
import type { HandlerContext } from '../dispatch/dispatch'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError, type RuntimeCallOptions } from '../runtime/connection/types'
import { MANAGED_SERVER_HANDLERS } from './managed-server'
import { callExpectingRestart } from './managed-server-request'

describe('orca environment update', () => {
  it('refuses plain force on a desktop that could end uncounted terminals', async () => {
    const status = { capabilities: [MANAGED_SERVER_RUNTIME_CAPABILITY] }
    const call = async (method: string, _params?: unknown, options?: RuntimeCallOptions) => {
      if (method === 'status.get') {
        return { id: 'status', ok: true, result: status, _meta: { runtimeId: 'legacy' } }
      }
      options?.requestSelection?.paramsForStatus(status)
      throw new Error('An update reached the older desktop.')
    }
    const context: HandlerContext = {
      flags: new Map<string, string | boolean>([
        ['environment', 'build-box'],
        ['force', true]
      ]),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the update handler only uses call.
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    }
    await expect(MANAGED_SERVER_HANDLERS['environment update']!(context)).rejects.toMatchObject({
      code: 'incompatible_runtime'
    })
  })

  it('reports an unknown outcome when a dispatched update loses its reply', async () => {
    const call = async (method: string, _params?: unknown, options?: RuntimeCallOptions) => {
      if (method === 'managedServer.status') {
        return { id: 'status', ok: true, result: { activeVersion: 'other-version' } }
      }
      options?.requestSelection?.onDispatch?.()
      throw new RuntimeClientError('runtime_unavailable', 'Connection closed.')
    }
    const context: HandlerContext = {
      flags: new Map(),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the request uses only call.
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: true
    }
    const selector = 'build box'
    await expect(
      callExpectingRestart(context, 'managedServer.update', { selector })
    ).rejects.toMatchObject({ code: 'managed_server_outcome_unknown', data: { selector } })
  })
})
