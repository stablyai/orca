import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import {
  readStoredCodexCredentialState,
  type StoredCodexCredentialState
} from './managed-codex-auth-readiness'

export const CODEX_CREDENTIAL_ABSENCE_GRACE_MS = 5_000
export const CODEX_CREDENTIAL_ABSENCE_MAX_TRACKED_PATHS = 512

export type CodexCredentialAbsenceVerdict = {
  state: StoredCodexCredentialState
  /** Whether the observed credential state is settled enough to act on. */
  durable: boolean
}

// Delay deselection during auth.json rotation; readable credential state needs no grace.
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
    // A missing home directory cannot be explained by auth.json rotation.
    if (state === 'missing' && !existsSync(dirname(authPath))) {
      this.firstAbsenceAtByPath.delete(key)
      return { state, durable: true }
    }
    const firstAbsenceAt = this.firstAbsenceAtByPath.get(key)
    if (firstAbsenceAt === undefined) {
      this.firstAbsenceAtByPath.set(key, now)
      while (this.firstAbsenceAtByPath.size > CODEX_CREDENTIAL_ABSENCE_MAX_TRACKED_PATHS) {
        const oldest = this.firstAbsenceAtByPath.keys().next()
        if (oldest.done) {
          break
        }
        this.firstAbsenceAtByPath.delete(oldest.value)
      }
      return { state, durable: false }
    }
    return { state, durable: now - firstAbsenceAt >= this.graceMs }
  }

  /** @internal - exposed for leak-regression tests. */
  trackedPathCountForTests(): number {
    return this.firstAbsenceAtByPath.size
  }
}
