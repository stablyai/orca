import { levenshtein } from '../../shared/edit-distance'
import type { VoiceRosterEntry } from './voice-control-roster'

/**
 * Maps a transcribed spoken name onto the live roster. Speech text is noisy (number words,
 * filler, near-miss homophones), so candidates are scored exact > prefix > token
 * containment > Levenshtein, and a top pair inside the ambiguity margin comes back for a
 * spoken "did you mean X or Y?" instead of a coin flip. Unresolvable names return
 * 'unresolved' — the caller answers with the roster it knows, never retries forever.
 */

export type AgentNameResolution =
  | { kind: 'resolved'; entry: VoiceRosterEntry }
  | { kind: 'ambiguous'; candidates: VoiceRosterEntry[] }
  | { kind: 'unresolved' }

const AMBIGUITY_MARGIN = 10
const CONSIDERATION_THRESHOLD = 40
const MAX_AMBIGUOUS_CANDIDATES = 3

const NUMBER_WORDS: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
  twenty: '20'
}

export function canonicalizeSpokenName(name: string): string {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((token) => NUMBER_WORDS[token] ?? token)
    .join(' ')
}

function scoreCandidate(spoken: string, candidate: string): number {
  if (spoken === candidate) {
    return 100
  }
  if (candidate.startsWith(spoken) || spoken.startsWith(candidate)) {
    return 85
  }
  const spokenTokens = new Set(spoken.split(' '))
  const candidateTokens = candidate.split(' ')
  const overlap = candidateTokens.filter((token) => spokenTokens.has(token)).length
  if (overlap > 0) {
    // Containment of the candidate's name inside the spoken phrase: filler words the
    // transcription added ("the fix login agent") don't count against the match.
    return 70 * (overlap / candidateTokens.length)
  }
  const compactSpoken = spoken.replaceAll(' ', '')
  const compactCandidate = candidate.replaceAll(' ', '')
  const distance = levenshtein(compactSpoken, compactCandidate)
  const allowed = Math.max(1, Math.floor(compactCandidate.length / 4))
  return distance <= allowed ? 50 - 10 * distance : 0
}

/** The model-facing reply when a spoken name matches several agents — one phrasing, three call sites. */
export function ambiguousNameReply(candidates: readonly VoiceRosterEntry[]): string {
  const names = candidates.map((candidate) => candidate.spokenName).join(' or ')
  return `That name is ambiguous — ask the user: did they mean ${names}?`
}

export function resolveAgentBySpokenName(
  spoken: string,
  roster: readonly VoiceRosterEntry[]
): AgentNameResolution {
  const canonical = canonicalizeSpokenName(spoken)
  if (!canonical) {
    return { kind: 'unresolved' }
  }
  const scored = roster
    .map((entry) => ({
      entry,
      score: scoreCandidate(canonical, canonicalizeSpokenName(entry.spokenName))
    }))
    .filter(({ score }) => score >= CONSIDERATION_THRESHOLD)
    .sort((a, b) => b.score - a.score)
  const best = scored[0]
  if (!best) {
    return { kind: 'unresolved' }
  }
  const runnerUp = scored[1]
  if (runnerUp && best.score - runnerUp.score < AMBIGUITY_MARGIN) {
    return {
      kind: 'ambiguous',
      candidates: scored
        .filter(({ score }) => best.score - score < AMBIGUITY_MARGIN)
        .slice(0, MAX_AMBIGUOUS_CANDIDATES)
        .map(({ entry }) => entry)
    }
  }
  return { kind: 'resolved', entry: best.entry }
}
