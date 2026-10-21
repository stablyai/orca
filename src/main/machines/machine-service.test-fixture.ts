import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { MachineProviderVerb } from '../../shared/machine-provider-command'
import {
  MachineProviderError,
  type MachineProviderSuccess,
  type ProviderMachine
} from '../../shared/machine-provider-protocol'
import type { MachineProviderKey } from '../../shared/machine-inventory'
import type { MachineSshTargets } from './machine-connect'
import type { RunMachineProviderVerbArgs } from './machine-provider-process'
import { MachineService, type MachineServiceDeps } from './machine-service'

export const KEY: MachineProviderKey = 'plugin:acme.omarchy/omarchy'
export const PROVIDER_NOW = '2026-10-18T12:00:00.000Z'
export const LOCAL_NOW = Date.parse(PROVIDER_NOW) - 5_000
const roots: string[] = []

export async function removeMachineServiceRoots(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
}

export type Handler = (args: RunMachineProviderVerbArgs) => Promise<MachineProviderSuccess>

export function machine(overrides: Partial<ProviderMachine> = {}): ProviderMachine {
  return {
    id: 'sbx-1',
    name: 'dev',
    lifetime: 'persistent',
    state: 'running',
    createdAt: PROVIDER_NOW,
    access: { kind: 'ssh', host: 'omarchy', port: 42200, user: 'dev', projectRoot: '/home/dev' },
    ...overrides
  }
}

export function envelope(args: RunMachineProviderVerbArgs) {
  return {
    protocolVersion: 1 as const,
    operationId: args.operationId,
    contextId: 'omarchy:neil',
    now: PROVIDER_NOW
  }
}

export const capabilities: Handler = async (args) => ({
  ...envelope(args),
  kind: 'capabilities',
  capabilities: {
    verbs: ['create', 'sleep', 'wake', 'archive', 'delete', 'get'],
    lifetimes: ['persistent', 'temporary'],
    maxTtlSeconds: 3600,
    contextId: 'omarchy:neil'
  }
})

export const reply =
  (value: ProviderMachine): Handler =>
  async (args) => ({
    ...envelope(args),
    kind: 'machine',
    machine: value
  })

export const inventory =
  (machines: ProviderMachine[]): Handler =>
  async (args) => ({
    ...envelope(args),
    kind: 'inventory',
    machines
  })

export const fail =
  (code: ConstructorParameters<typeof MachineProviderError>[0]): Handler =>
  async () => {
    throw new MachineProviderError(code, code)
  }

export async function setup(handlers: Partial<Record<MachineProviderVerb, Handler | Handler[]>>) {
  const userDataPath = await mkdtemp(join(tmpdir(), 'orca-machine-service-'))
  roots.push(userDataPath)
  const calls: RunMachineProviderVerbArgs[] = []
  const queues = new Map(
    Object.entries({ capabilities, ...handlers }).map(([verb, handler]) => [
      verb,
      Array.isArray(handler) ? [...handler] : [handler]
    ])
  )
  const runVerb = vi.fn(async (args: RunMachineProviderVerbArgs) => {
    calls.push(args)
    const queue = queues.get(args.verb)
    const handler = queue && queue.length > 1 ? queue.shift() : queue?.[0]
    if (!handler) {
      throw new MachineProviderError('unsupported', `no fake for ${args.verb}`)
    }
    return handler(args)
  })
  const sshTargets: MachineSshTargets = {
    getTarget: vi.fn(() => undefined),
    ensureTarget: vi.fn((id, fields) => ({ id, ...fields })),
    updateTarget: vi.fn(() => null),
    connect: vi.fn(async (id) => ({
      targetId: id,
      status: 'error' as const,
      error: 'Connection refused',
      reconnectAttempt: 0
    })),
    disconnect: vi.fn(async () => undefined)
  }
  const clock = { now: LOCAL_NOW }
  const removeSshTarget = vi.fn(async (_id: string) => undefined)
  const delay = vi.fn(async (_ms: number) => undefined)
  const deps: MachineServiceDeps = {
    userDataPath,
    listProviders: () => [
      { providerKey: KEY, name: 'Omarchy box', source: { command: ['x'], pluginRootDir: '/p' } }
    ],
    sshTargets,
    pairing: { add: vi.fn(), repair: vi.fn() },
    removeSshTarget,
    runVerb,
    now: () => clock.now,
    delay
  }
  const service = new MachineService(deps)
  const verbs = () => calls.map((call) => call.verb)
  return { service, deps, calls, verbs, userDataPath, sshTargets, removeSshTarget, delay, clock }
}
