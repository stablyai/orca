// The epoch rules of the edge-native director's assign (director-removal.md §3). The host's object
// is its placement: it keeps its assignment epoch across asks and bumps it only when the URL it
// hands out changes (front door <-> edge), so a desktop holding the old epoch gets WRONG_CELL at
// hello and re-asks, and a phone's invite move (which needs a strictly newer epoch) can follow.
import type { StoredAssignment } from './object-store'

export type DirectorAsk = { userId: string; relayHostId: string; cellUrl: string }

export type DirectorAssignPlan =
  // Moving away right now (an export froze it): ask again shortly.
  | { outcome: 'frozen' }
  // The legacy director placed the host on another cell: not this endpoint's to take.
  | { outcome: 'elsewhere' }
  // `write`: the assignment row to store first (`wipe`: the object's host data is void), or null
  // when the stored row already answers.
  | { outcome: 'assign'; assignmentEpoch: number; write: null | { wipe: boolean } }

export function planDirectorAssign(input: {
  current: StoredAssignment | null
  // The cell URL this endpoint last handed out for the host; undefined when it never answered
  // for it (the row came from a legacy director push).
  handedUrl: string | undefined
  frozen: boolean
  cellId: string
  ask: DirectorAsk
}): DirectorAssignPlan {
  const { current, handedUrl, ask } = input
  if (input.frozen) { return { outcome: 'frozen' } }
  // A fresh object: the host's first placement. Leftovers of an unplaced object are void.
  if (!current) { return { outcome: 'assign', assignmentEpoch: 1, write: { wipe: true } } }
  if (current.relayHostId !== ask.relayHostId || current.cellId !== input.cellId) { return { outcome: 'elsewhere' } }
  // Another account on the same machine (the object is per relayHostId): the earlier account's
  // devices and invites are void, as on a legacy move onto the edge.
  if (current.userId !== ask.userId) { return { outcome: 'assign', assignmentEpoch: current.assignmentEpoch + 1, write: { wipe: true } } }
  // A legacy push left no record of its URL: record this one; both reach this object.
  if (handedUrl !== undefined && handedUrl !== ask.cellUrl) {
    return { outcome: 'assign', assignmentEpoch: current.assignmentEpoch + 1, write: { wipe: false } }
  }
  return { outcome: 'assign', assignmentEpoch: current.assignmentEpoch, write: null }
}
