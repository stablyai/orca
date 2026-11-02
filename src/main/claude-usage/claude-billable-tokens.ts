import type { ClaudeUsageTokenTotals } from './types'

export type ClaudeBillableTokens = ClaudeUsageTokenTotals & {
  /** Subset from requests over the long-context threshold. */
  longContext?: ClaudeUsageTokenTotals
}

export function addTokenTotals(
  left: ClaudeUsageTokenTotals,
  right: ClaudeUsageTokenTotals,
  sign: 1 | -1 = 1
): ClaudeUsageTokenTotals {
  return {
    inputTokens: left.inputTokens + sign * right.inputTokens,
    outputTokens: left.outputTokens + sign * right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + sign * right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + sign * right.cacheWriteTokens,
    cacheWrite1hTokens: left.cacheWrite1hTokens + sign * right.cacheWrite1hTokens
  }
}

export function minTokenTotals(
  left: ClaudeUsageTokenTotals,
  right: ClaudeUsageTokenTotals
): ClaudeUsageTokenTotals {
  return {
    inputTokens: Math.min(left.inputTokens, right.inputTokens),
    outputTokens: Math.min(left.outputTokens, right.outputTokens),
    cacheReadTokens: Math.min(left.cacheReadTokens, right.cacheReadTokens),
    cacheWriteTokens: Math.min(left.cacheWriteTokens, right.cacheWriteTokens),
    cacheWrite1hTokens: Math.min(left.cacheWrite1hTokens, right.cacheWrite1hTokens)
  }
}

export function addBillableTokens(
  left: ClaudeBillableTokens,
  right: ClaudeBillableTokens
): ClaudeBillableTokens {
  const sum = addTokenTotals(left, right)
  const longContext =
    left.longContext && right.longContext
      ? addTokenTotals(left.longContext, right.longContext)
      : (left.longContext ?? right.longContext)
  return longContext ? { ...sum, longContext } : sum
}

export const NO_TOKENS: Readonly<ClaudeUsageTokenTotals> = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0
}

export function addLongContext(
  target: ClaudeBillableTokens,
  share: ClaudeUsageTokenTotals | undefined,
  sign: 1 | -1 = 1
): void {
  if (!share) {
    return
  }
  const next = addTokenTotals(target.longContext ?? NO_TOKENS, share, sign)
  if (Object.values(next).every((value) => value === 0)) {
    delete target.longContext
  } else {
    target.longContext = next
  }
}
