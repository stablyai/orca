import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MachineProgressEvent, MachineProviderKey } from '../../shared/machine-inventory'
import { MachineService } from './machine-service'

// Drives the real runner and response parser against the fake provider script; nothing is stubbed
// between the service and the provider's stdout.
const KEY: MachineProviderKey = 'plugin:acme.fake/fake'
const roots: string[] = []
const savedEnv = { ...process.env }

afterEach(async () => {
  process.env = { ...savedEnv }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function realService(
  onProgress?: (event: MachineProgressEvent) => void
): Promise<MachineService> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'orca-machine-contract-'))
  roots.push(userDataPath)
  process.env.FAKE_MACHINE_PROVIDER_STATE = join(userDataPath, 'provider-state.json')
  process.env.FAKE_MACHINE_PROVIDER_CONTEXT = 'fake:alice'
  return new MachineService({
    userDataPath,
    listProviders: () => [
      {
        providerKey: KEY,
        name: 'Fake',
        source: {
          command: ['$orca-node', '$plugin/fake-machine-provider.mjs'],
          pluginRootDir: join(__dirname, '__fixtures__')
        }
      }
    ],
    sshTargets: {
      getTarget: vi.fn(),
      ensureTarget: vi.fn(),
      updateTarget: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn()
    },
    pairing: { add: vi.fn(), repair: vi.fn() },
    removeSshTarget: vi.fn(async () => undefined),
    onProgress
  })
}

describe('MachineService against a real provider process', () => {
  it('streams create stderr tagged with the operation, never stdout', async () => {
    const events: MachineProgressEvent[] = []
    const service = await realService((event) => events.push(event))
    await service.create(KEY, { name: 'dev', lifetime: 'persistent' }, { operationId: 'op-ui' })
    expect(events.map((event) => event.chunk).join('')).toBe('provisioning machine\n')
    expect(events[0]).toMatchObject({
      operationId: 'op-ui',
      providerKey: KEY,
      verb: 'create',
      stream: 'stderr'
    })
  })

  it('applies nothing when another account answers not-found, then re-checks the account', async () => {
    const service = await realService()
    const created = await service.create(KEY, { name: 'dev', lifetime: 'persistent' })
    expect((await service.list(KEY, { force: true })).machines).toHaveLength(1)

    // The provider is now signed in as someone else and does not know this machine.
    process.env.FAKE_MACHINE_PROVIDER_CONTEXT = 'fake:mallory'
    process.env.FAKE_MACHINE_PROVIDER_STATE = join(roots[0]!, 'other-account.json')
    await expect(service.get(KEY, created.id)).rejects.toMatchObject({ code: 'context-mismatch' })
    const record = service.snapshots()[0]?.machines[0]
    expect(record?.state).not.toBe('gone')

    // The mismatch cleared the account check, so the next call asks capabilities again and keeps
    // failing closed while cached machines could be confused with the other account's.
    await expect(service.delete(KEY, created.id)).rejects.toMatchObject({
      code: 'context-mismatch'
    })
    expect(service.snapshots()[0]?.machines[0]?.state).not.toBe('gone')
  })
})
