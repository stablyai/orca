import { writeMultiRepoRecord, listMultiRepoFolderWorkspaces } from './multi-repo-workspace-record'
import type { MultiRepoRecordStore } from './multi-repo-workspace-record'

/** In-flight creates died with the previous process; they wait for an explicit Retry. */
export function recoverInterruptedMultiRepoMembers(store: MultiRepoRecordStore): number {
  let recovered = 0
  for (const workspace of listMultiRepoFolderWorkspaces(store)) {
    if (!workspace.multiRepo.members.some(isInFlight)) {
      continue
    }
    writeMultiRepoRecord(store, workspace.id, (current) => ({
      ...current,
      members: current.members.map((member) => {
        if (!isInFlight(member)) {
          return member
        }
        recovered += 1
        return { ...member, state: 'interrupted' }
      })
    }))
  }
  return recovered
}

function isInFlight(member: { state: string }): boolean {
  return member.state === 'queued' || member.state === 'creating'
}
