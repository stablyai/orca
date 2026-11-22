import { describe, expect, it } from 'vitest'
import { MANAGED_SERVER_RUNTIME_CAPABILITY } from '../../shared/remote-runtime/protocol/host-runtime-capabilities'
import type { HandlerContext } from '../dispatch/dispatch'
import type { RuntimeClient } from '../runtime/client'
import type { RuntimeCallOptions } from '../runtime/connection/types'
import { MANAGED_SERVER_HANDLERS } from './managed-server'

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
})
