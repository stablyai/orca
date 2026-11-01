import { describe, expect, it } from 'vitest'
import {
  DORMANT_LEAF_ID,
  DORMANT_WORKTREE_ID,
  dormantState,
  manifest
} from '../../persistence/migrating-orcad-catalog/persistence-orcad-migration-catalog-fixture'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import { preservesOrcadMigrationBridgedPanes } from '../orcad-migration-bridged-panes'
import { isBridgeableLease } from './legacy-relay-bridge-leases'

const LEASE: SshRemotePtyLease = {
  targetId: 'ssh-prod',
  ptyId: 'relay-pty',
  tabId: 'tab-dormant',
  leafId: DORMANT_LEAF_ID,
  worktreeId: DORMANT_WORKTREE_ID,
  state: 'detached',
  createdAt: 1,
  updatedAt: 1
}

describe('preserving the relay bridge when skipping saved state', () => {
  it('refuses when a tab survives but the running split pane is omitted', () => {
    const payload = { ...manifest().payload, dormantState: dormantState() }
    const session = payload.dormantState!.workspaceSession!
    session.terminalLayoutsByTabId[LEASE.tabId!]!.root = { type: 'leaf', leafId: 'other-leaf' }
    session.terminalLayoutsByTabId[LEASE.tabId!]!.activeLeafId = 'other-leaf'
    expect(
      preservesOrcadMigrationBridgedPanes(payload, [LEASE], [LEASE.ptyId], isBridgeableLease)
    ).toBe(false)
  })

  it('refuses a tab that moved to another workspace or whose lease identity is unknown', () => {
    const payload = { ...manifest().payload, dormantState: dormantState() }
    expect(
      preservesOrcadMigrationBridgedPanes(
        payload,
        [
          {
            ...LEASE,
            worktreeId: 'folder:other-folder'
          }
        ],
        [LEASE.ptyId],
        isBridgeableLease
      )
    ).toBe(false)
    expect(preservesOrcadMigrationBridgedPanes(payload, [], [LEASE.ptyId], isBridgeableLease)).toBe(
      false
    )
  })
})
