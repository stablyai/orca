import { beforeEach, expect, it, vi } from 'vitest'
import type { RegisteredPtyProvider } from './registry'
import { readRegisteredPtyProviderInventory } from './registered-provider-inventory'
import {
  reserveDelegatedPtyProviderRoute,
  retireDelegatedPtyProviderRoute
} from './delegated-provider-routes'
import { identity as base } from '../../../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import {
  listProcessesWithHostScopeFromRuntimeController,
  listProcessesFromRuntimeController
} from '../runtime/inventory-operations'
import { supportsForegroundProcessEvidenceFromRuntimeController } from '../runtime/foreground-process-evidence-capability'

const registry = vi.hoisted(() => ({ entries: [] as RegisteredPtyProvider[] }))
vi.mock('./registry', () => ({
  registeredPtyProviders: () => registry.entries,
  getProvider: (connectionId: string) =>
    registry.entries.find((entry) => entry.connectionId === connectionId)?.provider
}))
const identity = { ...base, terminalId: 'inventory-delegated' }
const native = { id: 'native', cwd: '/native', title: '' }
const delegated = {
  id: identity.terminalId,
  incarnationId: identity.incarnationId,
  cwd: '/source',
  title: ''
}
function entry(sessions = [delegated], connectionId: string | null = null): RegisteredPtyProvider {
  return { provider: { listProcesses: vi.fn(async () => sessions) } as never, connectionId }
}
beforeEach(() => {
  registry.entries = [entry([native] as never)]
})

it('filters retired native rows while preserving responding host coverage', async () => {
  const retired = { ...identity, terminalId: 'inventory-retired' }
  retireDelegatedPtyProviderRoute(retired, { generation: 1, claimId: 'retired' })
  registry.entries = [entry([native, { ...delegated, id: retired.terminalId }] as never)]
  await expect(listProcessesWithHostScopeFromRuntimeController({} as never)).resolves.toEqual({
    processes: [native],
    hostIds: ['local']
  })
})

it('combines native/delegated inventory once per host and forwards the deadline', async () => {
  reserveDelegatedPtyProviderRoute(identity)
  registry.entries = [
    entry([native, delegated] as never),
    { ...entry(), delegatedIdentity: identity }
  ]
  const options = { deadlineMs: Date.now() + 2000, includeForegroundProcessEvidence: true }
  const result = await listProcessesWithHostScopeFromRuntimeController({} as never, options)
  expect(result).toEqual({ processes: [native, delegated], hostIds: ['local'] })
  for (const registered of registry.entries) {
    expect(registered.provider!.listProcesses).toHaveBeenCalledWith(options)
  }
  await expect(listProcessesFromRuntimeController({} as never, null, options)).resolves.toEqual([
    native,
    delegated
  ])
})

it('does not treat an unbound reservation as an empty responding host', async () => {
  registry.entries.push({ provider: undefined, connectionId: null, delegatedIdentity: identity })
  const markPtyLivenessUnverifiable = vi.fn()
  await expect(
    listProcessesWithHostScopeFromRuntimeController({
      runtime: { markPtyLivenessUnverifiable }
    } as never)
  ).rejects.toThrow('inventory_unverifiable')
  expect(markPtyLivenessUnverifiable).toHaveBeenCalledWith(
    identity.terminalId,
    'delegated_pty_inventory_unverifiable'
  )
  await expect(listProcessesFromRuntimeController({} as never, null)).rejects.toThrow(
    'inventory_unverifiable'
  )
})

it.each([[], [{ ...delegated, incarnationId: 'other' }], [delegated, delegated]])(
  'refuses delegated inventory without exactly the bound incarnation (%j)',
  async (...sessions) => {
    await expect(
      readRegisteredPtyProviderInventory({
        ...entry(sessions.flat() as never),
        delegatedIdentity: identity
      })
    ).rejects.toThrow('identity_mismatch')
  }
)

it('rejects a stale route response and rechecks the whole batch before publishing', async () => {
  const current = vi.fn(() => true)
  const local = { ...entry([native] as never), isCurrent: current }
  registry.entries = [
    local,
    {
      provider: {
        listProcesses: async () => {
          current.mockReturnValue(false)
          return [delegated]
        }
      } as never,
      connectionId: null,
      delegatedIdentity: identity
    }
  ]
  await expect(listProcessesWithHostScopeFromRuntimeController({} as never)).rejects.toThrow(
    'superseded'
  )
})

it('does not include delegated routes when explicitly querying an SSH connection', async () => {
  registry.entries.push({ provider: undefined, connectionId: null, delegatedIdentity: identity })
  const ssh = entry([{ ...delegated, id: 'ssh:host@@pty' }], 'host')
  registry.entries.push(ssh)
  await expect(listProcessesFromRuntimeController({} as never, 'host')).resolves.toEqual([
    { ...delegated, id: 'ssh:host@@pty' }
  ])
})

it('does not infer delegated foreground capability from its host-local ID', async () => {
  registry.entries.push({ ...entry(), delegatedIdentity: identity })
  await expect(supportsForegroundProcessEvidenceFromRuntimeController(null)).resolves.toBe(false)
  registry.entries.pop()
  await expect(supportsForegroundProcessEvidenceFromRuntimeController(null)).resolves.toBe(true)
  registry.entries.push({ provider: undefined, connectionId: null, delegatedIdentity: identity })
  await expect(supportsForegroundProcessEvidenceFromRuntimeController()).resolves.toBe(false)
})

it('does not let an old inventory failure overwrite a replacement connection liveness verdict', async () => {
  const isCurrent = vi.fn(() => true)
  const markPtyLivenessUnverifiable = vi.fn()
  registry.entries.push({
    provider: {
      listProcesses: async () => {
        isCurrent.mockReturnValue(false)
        throw new Error('old route failed')
      }
    } as never,
    connectionId: null,
    delegatedIdentity: identity,
    isCurrent
  })
  await expect(
    listProcessesFromRuntimeController({ runtime: { markPtyLivenessUnverifiable } } as never, null)
  ).rejects.toThrow('old route failed')
  expect(markPtyLivenessUnverifiable).not.toHaveBeenCalled()
})
