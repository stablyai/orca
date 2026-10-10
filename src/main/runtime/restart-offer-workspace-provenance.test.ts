import { expect, it } from 'vitest'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

type Records = Pick<WorktreeMeta, 'creatorProvenance' | 'automationProvenance'>
import { readRestartOfferWorkspaceProvenance } from './restart-offer-workspace-provenance'

const MINE = { kind: 'paired-device' as const, deviceId: 'device-mine' }

function store(
  meta: Record<string, Records>,
  folders: Pick<FolderWorkspace, 'id' | 'creatorProvenance'>[]
) {
  return {
    getWorktreeMeta: (id: string): Records | undefined => meta[id],
    getFolderWorkspaces: () => folders
  }
}

it('reads a git worktree’s records by its id, and a folder workspace’s by its key', () => {
  const host = store({ 'repo::/work/a': { creatorProvenance: MINE } }, [
    { id: 'folder-1', creatorProvenance: { kind: 'host' } }
  ])
  expect(readRestartOfferWorkspaceProvenance(host, 'repo::/work/a')).toEqual({
    creatorProvenance: MINE,
    automationProvenance: undefined
  })
  expect(readRestartOfferWorkspaceProvenance(host, 'folder:folder-1')).toEqual({
    creatorProvenance: { kind: 'host' }
  })
})

it('has no record for a workspace the host does not know', () => {
  const host = store({}, [])
  expect(readRestartOfferWorkspaceProvenance(host, 'repo::/main')).toBeUndefined()
  expect(readRestartOfferWorkspaceProvenance(host, 'folder:gone')).toBeUndefined()
  expect(readRestartOfferWorkspaceProvenance(null, 'repo::/main')).toBeUndefined()
})
