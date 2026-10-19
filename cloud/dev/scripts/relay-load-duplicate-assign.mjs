// Step 5's equal-epoch case: two fresh assigns for one host that reach two director instances
// can each book a cell at the same epoch. The host connects with the first answer, and a twin
// with the same keys holds the other seat half-open, as a desktop that joined both would.
export async function proveRelayLoadDuplicateAssign({ pairs, holdMs, delay, failureReason }) {
  const result = {
    probes: pairs.length,
    bothAnswered: 0,
    splitCells: 0,
    sameEpochSplits: 0,
    joinedBoth: 0,
    refusalsByReason: {},
    connectFailuresByReason: {},
    // Not secrets: synthetic load hosts, listed so the ledger rows can be checked afterwards.
    splits: []
  }
  const count = (bucket, error) => {
    const reason = failureReason(error)
    bucket[reason] = (bucket[reason] ?? 0) + 1
  }
  const twins = []
  await Promise.all(
    pairs.map(async ({ primary, twin }) => {
      const answers = await Promise.allSettled([
        primary.requestAssignment(),
        primary.requestAssignment()
      ])
      for (const answer of answers) {
        if (answer.status === 'rejected') count(result.refusalsByReason, answer.reason)
      }
      const [first, second] = answers
        .filter((answer) => answer.status === 'fulfilled')
        .map((answer) => answer.value)
      if (!first) return
      if (second) result.bothAnswered++
      const split = second !== undefined && second.cellUrl !== first.cellUrl
      if (split) {
        result.splitCells++
        if (second.assignmentEpoch === first.assignmentEpoch) result.sameEpochSplits++
        result.splits.push({
          relayHostId: primary.relayHostId,
          first: { cellUrl: first.cellUrl, assignmentEpoch: first.assignmentEpoch },
          second: { cellUrl: second.cellUrl, assignmentEpoch: second.assignmentEpoch }
        })
      }
      try {
        await primary.connect(first)
      } catch (error) {
        count(result.connectFailuresByReason, error)
        return
      }
      if (!split) return
      try {
        await twin.connect(second)
        result.joinedBoth++
        twins.push(twin)
      } catch (error) {
        count(result.connectFailuresByReason, error)
      }
    })
  )
  if (twins.length > 0) {
    await delay(holdMs)
    await Promise.all(twins.map((twin) => twin.shutdown()))
  }
  return result
}
