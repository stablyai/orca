import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import {
  readStoredCodexCredentialState,
  type StoredCodexCredentialState
} from './managed-codex-auth-readiness'

export const CODEX_CREDENTIAL_ABSENCE_GRACE_MS = 5_000

export type CodexCredentialAbsenceVerdict = {
  state: StoredCodexCredentialState
  /** For 'missing'/'unreadable': true once the absence outlived the grace window. */
  durable: boolean
}

// Why: codex rotates auth.json in place, so one missing/unreadable read can be
// a write in progress. Deselecting the managed account on that snapshot logs
// the user out over a race; absence must persist across a grace window first.
// Valid JSON (with or without a credential) is a settled file and needs none.
export class CodexCredentialAbsenceGrace {
  private readonly firstAbsenceAtByPath = new Map<string, number>()

  constructor(private readonly graceMs = CODEX_CREDENTIAL_ABSENCE_GRACE_MS) {}

  assess(authPath: string, now = Date.now()): CodexCredentialAbsenceVerdict {
    const state = readStoredCodexCredentialState(authPath)
    const key = normalizeRuntimePathForComparison(authPath)
    if (state === 'present' || state === 'incomplete' || state === 'no-credential') {
      this.firstAbsenceAtByPath.delete(key)
      return { state, durable: true }
    }
    // Why: rotation replaces auth.json inside an existing home; the home
    // directory itself being gone is structural, not a write in flight.
    if (state === 'missing' && !existsSync(dirname(authPath))) {
      this.firstAbsenceAtByPath.delete(key)
      return { state, durable: true }
    }
    const firstAbsenceAt = this.firstAbsenceAtByPath.get(key)
    if (firstAbsenceAt === undefined) {
      this.firstAbsenceAtByPath.set(key, now)
      return { state, durable: false }
    }
    return { state, durable: now - firstAbsenceAt >= this.graceMs }
  }
}
