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
  it.each([DORMANT_WORKTREE_ID, 'folder:folder-1'])(
    'accepts the exported pane in %s with a host-qualified lease owner',
    (owner) => {
      const payload = { ...manifest().payload, dormantState: dormantState() }
      const session = payload.dormantState!.workspaceSession!
      session.tabsByWorktree = {
        [owner]: session.tabsByWorktree[DORMANT_WORKTREE_ID]!.map((tab) => ({
          ...tab,
          worktreeId: owner
        }))
      }
      expect(
        preservesOrcadMigrationBridgedPanes(
          payload,
          [
            {
              ...LEASE,
              worktreeId: `ssh:ssh-prod|${owner}`
            }
          ],
          [LEASE.ptyId],
          isBridgeableLease
        )
      ).toBe(true)
    }
  )

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

  it('does not require the omitted pane of a superseded lease the bridge never serves', () => {
    const payload = { ...manifest().payload, dormantState: dormantState() }
    const superseded = {
      ...LEASE,
      ptyId: 'old-pty',
      tabId: 'closed-tab',
      supersededBy: LEASE.ptyId
    }
    expect(
      preservesOrcadMigrationBridgedPanes(
        payload,
        [LEASE, superseded],
        [LEASE.ptyId, superseded.ptyId],
        isBridgeableLease
      )
    ).toBe(true)
    expect(
      preservesOrcadMigrationBridgedPanes(payload, [LEASE, superseded], [superseded.ptyId])
    ).toBe(false)
  })
})
