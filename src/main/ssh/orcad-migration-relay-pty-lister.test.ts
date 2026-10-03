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

  it('lets the gate prove exit only when the relay answers with nothing running', async () => {
    const running = orcadMigrationRelayPtyLister(TARGET, {
      listProcesses: async () => [{ id: toAppSshPtyId(TARGET, 'pty-7'), cwd: '', title: 'pwsh' }]
    })
    expect(await assessOrcadMigrationTerminals(noLeases, TARGET, running)).toMatchObject({
      verdict: 'live',
      ptyIds: ['pty-7']
    })
    const idle = orcadMigrationRelayPtyLister(TARGET, { listProcesses: async () => [] })
    expect(await assessOrcadMigrationTerminals(noLeases, TARGET, idle)).toEqual({
      verdict: 'exited',
      provenPtyIds: []
    })
  })

  it('has no lister without a connected relay session', () => {
    expect(orcadMigrationRelayPtyLister(TARGET)).toBeNull()
  })
})
