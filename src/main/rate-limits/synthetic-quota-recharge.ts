export function estimateSyntheticQuotaRechargeAt({
  usedPercent,
  nextRefillAt,
  refillPercent,
  intervalMs
}: {
  usedPercent: number
  nextRefillAt: number | null
  refillPercent: number | null
  intervalMs: number | null
}): number | null {
  if (
    !Number.isFinite(usedPercent) ||
    usedPercent <= 0 ||
    nextRefillAt === null ||
    !Number.isFinite(nextRefillAt) ||
    refillPercent === null ||
    !Number.isFinite(refillPercent) ||
    refillPercent <= 0 ||
    intervalMs === null ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0
  ) {
    return null
  }
  const ticks = Math.ceil((Math.min(100, usedPercent) - 1e-9) / refillPercent)
  const rechargeAt = nextRefillAt + Math.max(0, ticks - 1) * intervalMs
  return Number.isFinite(rechargeAt) ? rechargeAt : null
}

export function getSyntheticRequestRefillPercent(tickPercent: unknown): number | null {
  return typeof tickPercent === 'number' &&
    Number.isFinite(tickPercent) &&
    tickPercent > 0 &&
    tickPercent <= 1
    ? tickPercent * 100
    : null
}

function parseCreditAmount(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\$?\d+(?:\.\d+)?$/.test(value)) {
    return null
  }
  const amount = Number(value.replace(/^\$/, ''))
  return Number.isFinite(amount) && amount > 0 ? amount : null
}

export function getSyntheticCreditRefillPercent(
  maxCredits: unknown,
  nextRegenCredits: unknown
): number | null {
  const maximum = parseCreditAmount(maxCredits)
  const refill = parseCreditAmount(nextRegenCredits)
  return maximum !== null && refill !== null ? (refill / maximum) * 100 : null
}
