// Reject nonpositive/invalid run counts; a zero-iteration verification would silently pass without recording anything.
export function determinismRuns(): number {
  const raw = process.env.RPC_FOUNDATION_DETERMINISM_RUNS
  if (raw === undefined) {
    return 2
  }
  const runs = Number(raw)
  if (!Number.isInteger(runs) || runs < 2) {
    throw new Error(
      `RPC_FOUNDATION_DETERMINISM_RUNS must be an integer >= 2 to compare a run against another; got ${JSON.stringify(raw)}`
    )
  }
  return runs
}
