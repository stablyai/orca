import type { crewRecipientOwnerQueries, DispatchInput } from './crew-recipient-owner-queries'

export function createCrewRecipientFollowUpInputs(
  query: Pick<ReturnType<typeof crewRecipientOwnerQueries>, 'followUps'>
) {
  const followUpNodes = new Map<string, ReturnType<typeof query.followUps>[number] | null>()
  const prepareFollowUps = (selected: DispatchInput[]) => {
    const seeds = selected
      .filter(
        (row) =>
          row.protocol_version === null &&
          row.status !== 'pending' &&
          row.status !== 'dispatched' &&
          (row.worker_state !== null ||
            row.follow_up_of_dispatch_id !== null ||
            row.next_dispatch_id !== null)
      )
      .map((row) => row.id)
      .filter((id) => !followUpNodes.has(id))
    if (!seeds.length) {
      return
    }
    const rows = query.followUps([...new Set(seeds)])
    const complete = new Map<string, ReturnType<typeof query.followUps>[number] | null>(
      seeds.map((id) => [id, null])
    )
    for (const row of rows) {
      for (const id of [
        row.follow_up_of_dispatch_id,
        row.next_dispatch_id,
        row.lineage_resource?.owner_dispatch_id,
        row.lineage_resource?.origin_dispatch_id
      ]) {
        if (id && !complete.has(id)) {
          complete.set(id, null)
        }
      }
    }
    for (const row of rows) {
      complete.set(row.id, row)
    }
    for (const [id, row] of complete) {
      followUpNodes.set(id, row)
    }
  }
  return { followUpNodes, prepareFollowUps }
}
