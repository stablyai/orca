import { describe, expect, it, vi } from 'vitest'

vi.mock('../ipc/pty/provider/registry', () => ({ getSshPtyProvider: vi.fn(() => undefined) }))

import { toAppSshPtyId } from '../providers/ssh-pty-id'
import { assessOrcadMigrationTerminals } from './orcad-migration-terminal-gate'
import {
  ORCAD_MIGRATION_RELAY_LIST_BUDGET_MS,
  orcadMigrationRelayPtyLister
} from './orcad-migration-relay-pty-lister'

const TARGET = 'ssh-win'
const noLeases = { getSshRemotePtyLeases: () => [] }

describe('the terminal gate asking a relay what it still runs', () => {
  it('answers in the relay spelling the leases use, within a bounded deadline', async () => {
    const listProcesses = vi.fn(async () => [
      { id: toAppSshPtyId(TARGET, 'pty-7'), cwd: '', title: 'cmd.exe' }
    ])
    const lister = orcadMigrationRelayPtyLister(TARGET, { listProcesses }, () => 1_000)
    expect(await lister?.()).toEqual(['pty-7'])
    expect(listProcesses).toHaveBeenCalledWith({
      deadlineMs: 1_000 + ORCAD_MIGRATION_RELAY_LIST_BUDGET_MS
    })
  })

  it('lets the gate prove exit only when every relay answers with nothing running', async () => {
    const running = orcadMigrationRelayPtyLister(TARGET, {
      listProcesses: async () => [{ id: toAppSshPtyId(TARGET, 'pty-7'), cwd: '', title: 'pwsh' }]
    })
    expect(await assessOrcadMigrationTerminals(noLeases, TARGET, running)).toMatchObject({
      verdict: 'live',
      ptyIds: ['pty-7']
    })
    const idle = orcadMigrationRelayPtyLister(
      TARGET,
      { listProcesses: async () => [] },
      Date.now,
      async () => []
    )
    const hostIdle = async () => ({ verdict: 'exited' as const, count: 0 })
    expect(await assessOrcadMigrationTerminals(noLeases, TARGET, idle, hostIdle)).toEqual({
      verdict: 'exited',
      provenPtyIds: []
    })
    // Earlier relays that cannot be asked leave it unverifiable, even with nothing leased here.
    const unasked = orcadMigrationRelayPtyLister(
      TARGET,
      { listProcesses: async () => [] },
      Date.now,
      async () => null
    )
    expect(await assessOrcadMigrationTerminals(noLeases, TARGET, unasked)).toMatchObject({
      verdict: 'unverifiable'
    })
  })

  it('has no lister without a connected relay session', () => {
    expect(orcadMigrationRelayPtyLister(TARGET)).toBeNull()
  })

  it("asks earlier-build relays in the leases' spelling, keeping an unknown answer null", async () => {
    const provider = { listProcesses: async () => [] }
    const held = orcadMigrationRelayPtyLister(TARGET, provider, Date.now, async () => [
      toAppSshPtyId(TARGET, 'pty-old')
    ])
    expect(await held?.previous?.()).toEqual(['pty-old'])
    const unknown = orcadMigrationRelayPtyLister(TARGET, provider, Date.now, async () => null)
    expect(await unknown?.previous?.()).toBeNull()
  })
})
