/**
 * Each drive letter's last settled answer from any lookup: the WSL share it maps to, or nowhere.
 * Background paths read only these, never a drive (a mapped share's read can boot its distro).
 */
import { parseWslUncPath } from '../../../shared/file-access/wsl-paths'

/** `read`: Windows answered; `failed`: the lookup errored. Absent on answers saved before either. */
export type WslMappedDriveLookup = 'read' | 'failed'

/** A letter's settled answer: the share it maps to (null: nowhere), when, and how it was learned. */
export type WslMappedDriveAnswer = {
  letter: string
  share: string | null
  at: number
  lookup?: WslMappedDriveLookup
}

type Known = Omit<WslMappedDriveAnswer, 'letter'>

const lastKnown = new Map<string, Known>()
// Told every changed answer, so a restart knows a drive without reading it.
let answerSink: ((answers: WslMappedDriveAnswer[]) => void) | null = null
let settledListeners: (() => void)[] = []

function isWslShare(share: string | null): share is string {
  return share !== null && parseWslUncPath(share) !== null
}

function settle(key: string, known: Known): void {
  lastKnown.set(key, known)
  answerSink?.(wslMappedDriveAnswers())
  const listeners = settledListeners
  settledListeners = []
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.warn('[wsl] Mapped-drive answer listener failed:', error)
    }
  }
}

/** A lookup's answer: the drive root's final path, kept as a share only inside WSL. */
export function rememberWslMappedDriveRead(key: string, real: string, at: number): string | null {
  const share = isWslShare(real) ? real.replace(/[\\/]+$/, '') : null
  settle(key, { share, at, lookup: 'read' })
  return share
}

/**
 * A failed lookup: maps nowhere, unless the letter was last known in WSL. A WSL share that fails
 * to answer (its distro stopped, say) is not proof it moved, so that answer stands; true then.
 */
export function rememberWslMappedDriveFailure(key: string, at: number): boolean {
  if (isWslShare(lastKnown.get(key)?.share ?? null)) {
    return true
  }
  settle(key, { share: null, at, lookup: 'failed' })
  return false
}

export function setWslMappedDriveAnswerSink(
  sink: ((answers: WslMappedDriveAnswer[]) => void) | null
): void {
  answerSink = sink
}

/** Calls `listener` once, when the next lookup settles; returns the cancel. */
export function onNextWslMappedDriveAnswer(listener: () => void): () => void {
  settledListeners.push(listener)
  return () => {
    settledListeners = settledListeners.filter((other) => other !== listener)
  }
}

export function wslMappedDriveAnswers(): WslMappedDriveAnswer[] {
  return [...lastKnown].map(([letter, known]) => ({ letter, ...known }))
}

/** Seeds answers read from disk; one already settled in this run is newer and wins. */
export function seedWslMappedDriveAnswers(answers: readonly WslMappedDriveAnswer[]): void {
  for (const { letter, share, at, lookup } of answers) {
    const key = letter.toUpperCase()
    if (!lastKnown.has(key)) {
      lastKnown.set(key, lookup ? { share, at, lookup } : { share, at })
    }
  }
}

/**
 * The letter's last answer, never read here; null before any lookup of it settled, when it is
 * older than `maxAgeMs`, or dated after `now` (a clock that moved back can't vouch for it).
 */
export function wslMappedDriveLastKnownShare(
  letter: string,
  maxAgeMs = Number.POSITIVE_INFINITY,
  now: number = Date.now()
): { share: string | null; lookup?: WslMappedDriveLookup } | null {
  const known = lastKnown.get(letter.toUpperCase())
  return known && known.at <= now && now - known.at < maxAgeMs
    ? { share: known.share, lookup: known.lookup }
    : null
}

/** Whether the letter's last answer, of any age, maps into WSL. */
export function isWslMappedDriveLastKnownInWsl(letter: string, now: number = Date.now()): boolean {
  return isWslShare(
    wslMappedDriveLastKnownShare(letter, Number.POSITIVE_INFINITY, now)?.share ?? null
  )
}
