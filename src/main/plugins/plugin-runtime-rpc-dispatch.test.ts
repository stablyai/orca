import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineMethod } from '../runtime/rpc/core'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { pluginHostCallRevoked } from './workers/host-api/plugin-host-call-scope'
import { pluginRuntimeRpc } from './plugin-runtime-rpc'

function harness() {
  const ran: unknown[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reads only these runtime members for plain methods.
  const runtime = {
    getRuntimeId: () => 'rt',
    recordFeatureInteraction: vi.fn()
  } as unknown as OrcaRuntimeService
  const methods = [
    defineMethod({
      name: 'terminal.create',
      permission: 'workspace',
      params: z.object({ command: z.string().optional() }),
      handler: (params) => {
        ran.push(params)
        return { terminal: { handle: 'h' } }
      }
    })
  ]
  return { rpc: pluginRuntimeRpc(runtime, methods), ran }
}

describe('pluginRuntimeRpc', () => {
  it('refuses with the revocation itself when the plugin lost approval before the effect', async () => {
    const { rpc, ran } = harness()
    await expect(
      rpc(
        'terminal.create',
        {},
        {
          beforeEffect: () => {
            throw pluginHostCallRevoked()
          }
        }
      )
    ).rejects.toMatchObject({ code: 'consent_required' })
    expect(ran).toEqual([])
  })
})
