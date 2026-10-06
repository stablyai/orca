/**
 * How many times each scenario is recorded and compared against itself.
 *
 * Why it validates instead of coercing: the loop bound came straight from `Number(env ?? 2)`, so
 * `0`, `-1` or a typo skipped the body entirely and every scenario reported green having recorded
 * and compared nothing. A verification suite must not have a silent no-op mode.
 */
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
