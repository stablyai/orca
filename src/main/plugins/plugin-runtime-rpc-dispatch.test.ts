import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineMethod } from '../runtime/rpc/core'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { pluginHostCallRevoked } from './workers/host-api/plugin-host-call-scope'
import { pluginRuntimeRpc } from './plugin-runtime-rpc'
import { AUTOMATION_METHODS } from '../runtime/rpc/methods/automations/automations'

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

describe('automation.create provenance', () => {
  function automationHarness() {
    const createAutomation = vi.fn(async (input: Record<string, unknown>) => ({
      id: 'a1',
      ...input
    }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: automation.create reads only these runtime members.
    const runtime = {
      getRuntimeId: () => 'rt',
      recordFeatureInteraction: vi.fn(),
      createAutomation
    } as unknown as OrcaRuntimeService
    return { rpc: pluginRuntimeRpc(runtime, AUTOMATION_METHODS), createAutomation }
  }
  const create = {
    name: 'Nightly',
    prompt: 'Check dependencies',
    agentId: 'claude',
    repo: 'id:r1',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: 1,
    createdBy: { kind: 'plugin', pluginKey: 'forged.key', name: 'Forged' }
  }

  it('records the calling plugin, never a creator the params claim', async () => {
    const { rpc, createAutomation } = automationHarness()
    await rpc('automation.create', create, { plugin: { key: 'acme.deps', name: 'Deps' } })
    expect(createAutomation.mock.calls[0]?.[0]).toMatchObject({
      createdBy: { kind: 'plugin', pluginKey: 'acme.deps', name: 'Deps' }
    })
    await rpc('automation.create', create)
    expect(createAutomation.mock.calls[1]?.[0]).not.toHaveProperty('createdBy')
  })
})
