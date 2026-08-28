import type { ControlPlaneStore, OutcomeRelationRow } from './control-plane-store'
import type { OutcomeAdmissionError } from './outcome-identity'
import type { OutcomeIntakeRequest } from './outcome-intake'

/** A `serialize` decision is symmetric mutual exclusion, so an ordinary cycle
 *  through it cannot deadlock — at most one member of the cycle runs at a time,
 *  and nothing holds while it waits. Two shapes DO deadlock permanently, and
 *  both are rejected at intake rather than discovered at the first blocked start:
 *
 *  - an outcome serialized against itself, which blocks on its own Dispatch;
 *  - two outcomes a chain of `merge` decisions already made one, which then
 *    means the same work is serialized against itself by another name.
 */
function findContradiction(
  relations: readonly {
    leftOutcomeId: string
    rightOutcomeId: string
    decision: OutcomeRelationRow['decision']
  }[]
): OutcomeAdmissionError | undefined {
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== undefined && parent.get(root) !== root) {
      root = parent.get(root) as string
    }
    return root
  }
  for (const relation of relations) {
    if (relation.decision === 'merge') {
      const [left, right] = [find(relation.leftOutcomeId), find(relation.rightOutcomeId)]
      parent.set(left, right)
      parent.set(right, right)
    }
  }
  for (const relation of relations) {
    if (relation.decision !== 'serialize') {
      continue
    }
    if (relation.leftOutcomeId === relation.rightOutcomeId) {
      return {
        code: 'self_serialized_outcome',
        outcomeId: relation.leftOutcomeId,
        runId: '',
        reason: `Outcome ${relation.leftOutcomeId} is serialized against itself, so its own Dispatch would block it forever.`
      }
    }
    if (find(relation.leftOutcomeId) === find(relation.rightOutcomeId)) {
      return {
        code: 'serialized_with_merged_outcome',
        outcomeId: relation.leftOutcomeId,
        runId: '',
        reason: `${relation.leftOutcomeId} and ${relation.rightOutcomeId} are merged into one outcome, so serializing them against each other deadlocks both.`
      }
    }
  }
  return undefined
}

/** Every relation this intake would leave in place: the ones it declares, plus
 *  the ones already recorded for the outcomes it touches. */
export function findSerializationDeadlock(
  store: ControlPlaneStore,
  request: OutcomeIntakeRequest
): OutcomeAdmissionError | undefined {
  return findContradiction([
    ...(request.relations ?? []),
    ...request.outcomes.flatMap((outcome) =>
      store.listOutcomeRelations(outcome.outcomeId).map((row) => ({
        leftOutcomeId: row.left_outcome_id,
        rightOutcomeId: row.right_outcome_id,
        decision: row.decision
      }))
    )
  ])
}
