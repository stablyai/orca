import { describe, expect, it } from 'vitest'
import { orcadMigrationRefusalReason } from './orcad-migration-refusal-reason'

describe('orcadMigrationRefusalReason', () => {
  it('names each blocking kind once, in plain words', () => {
    expect(
      orcadMigrationRefusalReason([
        {
          code: 'orcad_migration_direct_ssh_repositories',
          category: 'drainable-static-state',
          repositories: []
        },
        {
          code: 'orcad_migration_dependent_state',
          category: 'client-owned-state',
          dependencies: [
            { kind: 'workspace-session', count: 7 },
            { kind: 'worktree-lineage', count: 1 },
            { kind: 'workspace-lineage', count: 1 },
            { kind: 'automation', count: 2 }
          ]
        },
        {
          code: 'orcad_migration_direct_ssh_terminal_leases',
          category: 'live-or-unverifiable',
          terminalLeases: []
        }
      ])
    ).toBe(
      'This SSH host cannot move yet: saved tabs and panes, workspace history, automations, terminals still running.'
    )
  })

  it('keeps the bare refusal when nothing that blocks is named', () => {
    expect(orcadMigrationRefusalReason([])).toBe('This SSH host cannot move yet.')
  })
})
