import { useMemo } from 'react'
import { MultiRepoDeleteSheet } from '../components/MultiRepoDeleteSheet'
import type { useMultiRepoWorkspaceActions } from './use-multi-repo-workspace-actions'

/** The delete confirmation for the multi-repo workspace the list's long-press picked. */
export function HostMultiRepoDeleteSheet({
  multiRepo
}: {
  multiRepo: ReturnType<typeof useMultiRepoWorkspaceActions>
}) {
  const target = multiRepo.deleteTarget
  const memberNames = useMemo(
    () =>
      new Map((target?.multiRepo.members ?? []).map((member) => [member.memberId, member.dirName])),
    [target]
  )
  return (
    <MultiRepoDeleteSheet
      client={multiRepo.deleteClient}
      folderWorkspaceId={target?.multiRepo.folderWorkspaceId ?? null}
      workspaceName={target?.row.displayName ?? ''}
      memberNames={memberNames}
      onClose={multiRepo.closeDelete}
    />
  )
}
