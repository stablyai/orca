import {
  LEGACY_SOURCE_REFUSALS,
  type LegacySourceRefusalReason
} from './journal-legacy-retention-error'
import type { LegacyCompanionManifest } from './journal-legacy-retirement-files'

export const LEGACY_SOURCE_REFUSAL_POLICY = 2
export const LEGACY_RETIREMENT_WEEK = 7 * 24 * 60 * 60 * 1000
export type Retirement = {
  version: 1
  proof: string
  proofId: string
  completedAt: number
  process: string
  credit: number
  creditRevision: number
  lastWall: number
  phase: 'grace' | 'prepared' | 'complete'
  manifest?: LegacyCompanionManifest
}

export type LegacySourceRefusal = {
  version: 1
  phase: 'refused'
  policy: typeof LEGACY_SOURCE_REFUSAL_POLICY
  proof: string
  observed: string
  destination: string
  reason: LegacySourceRefusalReason
}

export function decodeLegacySourceRefusal(value: string | null): LegacySourceRefusal | null {
  const data: unknown = value ? JSON.parse(value) : null
  if (!data || typeof data !== 'object' || !('phase' in data) || data.phase !== 'refused') {
    return null
  }
  if (
    !('version' in data) ||
    data.version !== 1 ||
    !('policy' in data) ||
    data.policy !== LEGACY_SOURCE_REFUSAL_POLICY ||
    !('proof' in data) ||
    typeof data.proof !== 'string' ||
    !('observed' in data) ||
    typeof data.observed !== 'string' ||
    !('destination' in data) ||
    typeof data.destination !== 'string' ||
    !('reason' in data) ||
    typeof data.reason !== 'string'
  ) {
    return null
  }
  const reason = LEGACY_SOURCE_REFUSALS.find((reason) => reason === data.reason)
  return reason
    ? {
        version: 1,
        phase: 'refused',
        policy: LEGACY_SOURCE_REFUSAL_POLICY,
        proof: data.proof,
        observed: data.observed,
        destination: data.destination,
        reason
      }
    : null
}

export function decodeRetirement(value: string | null): Retirement | null {
  if (!value) {
    return null
  }
  const data: Retirement | { phase: 'refused' } = JSON.parse(value)
  if (data.phase === 'refused') {
    return null
  }
  if (
    data.version !== 1 ||
    typeof data.proof !== 'string' ||
    typeof data.proofId !== 'string' ||
    typeof data.process !== 'string' ||
    !['grace', 'prepared', 'complete'].includes(data.phase) ||
    !Number.isFinite(data.credit) ||
    data.credit < 0 ||
    data.credit > LEGACY_RETIREMENT_WEEK ||
    !Number.isSafeInteger(data.creditRevision) ||
    data.creditRevision < 0
  ) {
    throw new Error('invalid legacy retirement receipt')
  }
  return data
}

export function advanceLegacyRetirementClock(
  state: Retirement,
  now: number,
  elapsed: number,
  processToken: string
): Retirement {
  if (
    !Number.isFinite(state.completedAt) ||
    !Number.isFinite(state.lastWall) ||
    state.completedAt < 0 ||
    state.lastWall < 0 ||
    state.completedAt > now ||
    state.lastWall > now
  ) {
    return {
      ...state,
      completedAt: now,
      lastWall: now,
      credit: 0,
      process: processToken,
      phase: 'grace'
    }
  }
  return {
    ...state,
    credit: Math.min(
      LEGACY_RETIREMENT_WEEK,
      state.credit + Math.max(0, Number.isFinite(elapsed) ? elapsed : 0)
    ),
    lastWall: now
  }
}

/** Absolute revisions discard ambiguous saved credit instead of counting one interval twice. */
export class JournalLegacyGraceClock {
  private anchor?: bigint
  private revision?: string
  private pending = 0

  observe(state: Retirement, now: number, processToken: string): Retirement {
    const revision = `${state.proofId}:${state.creditRevision}`
    if (this.revision !== revision) {
      this.pending = 0
      this.anchor = undefined
      this.revision = revision
    }
    const mono = process.hrtime.bigint()
    if (this.anchor !== undefined && mono >= this.anchor) {
      this.pending += Number(mono - this.anchor) / 1e6
    }
    this.anchor = mono
    return advanceLegacyRetirementClock(state, now, this.pending, processToken)
  }

  persisted(state: Retirement): void {
    this.revision = `${state.proofId}:${state.creditRevision}`
    this.pending = 0
    this.anchor = process.hrtime.bigint()
  }

  pause(): void {
    const mono = process.hrtime.bigint()
    if (this.anchor !== undefined && mono >= this.anchor) {
      this.pending += Number(mono - this.anchor) / 1e6
    }
    this.anchor = undefined
  }
}
