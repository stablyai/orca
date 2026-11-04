import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  activationFenceExists,
  createOrcadIdleProbes,
  resolveOrcadManagedIdleExit,
  type OrcadManagedIdleExitPorts
} from './orcad-managed-idle-exit'
import { ORCAD_E2E_IDLE_TIMEOUT_ENV } from '../../shared/orcad-idle-exit'

const config = { timeoutMs: 1_000, activationRoot: '/home/u/.orca-remote/.fence' }

function idlePorts(): OrcadManagedIdleExitPorts {
  return {
    readClientActivity: () => ({ openConnections: 0, requestsInFlight: 0, lastRequestAt: 0 }),
    listTerminals: async () => [],
    countDaemonSessions: async () => 0,
    hasDaemon: () => true,
    agentStates: () => [{ state: 'done' }],
    hasChatProviders: () => false,
    hasStagedMigration: () => false,
    automationsBusy: () => false,
    emulatorsBusy: async () => false,
    activationFenceExists: async () => false
  }
}

async function verdicts(ports: OrcadManagedIdleExitPorts): Promise<Record<string, string>> {
  const entries = await Promise.all(
    createOrcadIdleProbes(config, ports).map(async (probe) => [probe.name, await probe.read()])
  )
  return Object.fromEntries(entries)
}

describe('resolveOrcadManagedIdleExit', () => {
  it('stays off for a server the user started or paired', () => {
    expect(resolveOrcadManagedIdleExit({})).toBeNull()
    expect(resolveOrcadManagedIdleExit({ [ORCAD_E2E_IDLE_TIMEOUT_ENV]: '50' })).toBeNull()
  })
})

describe('createOrcadIdleProbes', () => {
  it.each<[string, Partial<OrcadManagedIdleExitPorts>, string]>([
    [
      'an open client socket',
      {
        readClientActivity: () => ({ openConnections: 1, requestsInFlight: 0, lastRequestAt: 0 })
      },
      'clients'
    ],
    [
      'a request still running',
      {
        readClientActivity: () => ({ openConnections: 0, requestsInFlight: 1, lastRequestAt: 0 })
      },
      'clients'
    ],
    ['an in-process terminal', { listTerminals: async () => [{ id: 'pty-1' }] }, 'terminals'],
    ['a live daemon session', { countDaemonSessions: async () => 2 }, 'terminals'],
    ['a working agent', { agentStates: () => [{ state: 'working' }] }, 'agents'],
    ['a loaded chat provider', { hasChatProviders: () => true }, 'chat-providers'],
    ['a staged migration', { hasStagedMigration: () => true }, 'migration'],
    ['an enabled or running automation', { automationsBusy: () => true }, 'automations'],
    ['an Orca-started emulator', { emulatorsBusy: async () => true }, 'emulators'],
    ['a held activation fence', { activationFenceExists: async () => true }, 'activation']
  ])('reads %s as busy', async (_label, override, probe) => {
    expect((await verdicts({ ...idlePorts(), ...override }))[probe]).toBe('busy')
  })

  it('treats a daemon that did not answer as unverifiable, not as no terminals', async () => {
    const result = await verdicts({ ...idlePorts(), countDaemonSessions: async () => null })
    expect(result.terminals).toBe('unverifiable')
  })

  it('needs only the provider census when this orcad runs without a daemon', async () => {
    const result = await verdicts({
      ...idlePorts(),
      hasDaemon: () => false,
      countDaemonSessions: async () => null
    })
    expect(result.terminals).toBe('idle')
  })
})

describe('activationFenceExists', () => {
  let root: string | null = null
  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('follows the lock a client holds during an update, not a root an aborted acquire left', async () => {
    root = mkdtempSync(join(tmpdir(), 'orcad-fence-'))
    const fence = join(root, '.orcad-activation-transaction')
    expect(await activationFenceExists(fence)).toBe(false)
    mkdirSync(fence)
    expect(await activationFenceExists(fence)).toBe(false)
    mkdirSync(join(fence, '.install-lock'))
    expect(await activationFenceExists(fence)).toBe(true)
  })
})
