// Encrypted local storage for the audited Codex provider API key.
//
// Mirrors audited-triage-api-key-store.ts's safeStorage-backed pattern exactly,
// kept as a SEPARATE file/key so the two features' secrets are never conflated:
// a user may configure triage without a custom Codex provider, or vice versa,
// and leaking one feature's credential into the other's launch would be a real
// defect rather than a convenience.
//
// TRANCHE 1 SCOPE: this record is the ONLY durable provider state. Its presence
// derives the selection of the sole fixed provider — there is no separate
// settings write, and therefore no cross-store window to reconcile. No launch
// path reads the value while credential delivery is disabled.
import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROVIDER_TOKEN_FILE = 'audited-workflow-codex-provider-token.enc'
let cachedProviderKey: string | null = null

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function getProviderKeyPath(): string {
  return join(getOrcaDir(), PROVIDER_TOKEN_FILE)
}

/**
 * Whether a key record exists. This is also what DERIVES provider selection —
 * a present record means the sole fixed provider is selected.
 */
export function hasAuditedCodexProviderKey(): boolean {
  return existsSync(getProviderKeyPath())
}

export function saveAuditedCodexProviderKey(apiKey: string): void {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    throw new Error('Codex provider API key is required')
  }
  ensureOrcaDir()
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(getProviderKeyPath(), safeStorage.encryptString(trimmed), { mode: 0o600 })
    cachedProviderKey = trimmed
    return
  }

  console.warn(
    '[auditedWorkflow] safeStorage encryption unavailable — storing Codex provider key in plaintext'
  )
  writeFileSync(getProviderKeyPath(), trimmed, { encoding: 'utf8', mode: 0o600 })
  cachedProviderKey = trimmed
}

/**
 * Reads the decrypted key.
 *
 * TRANCHE 1: no launch path calls this — there is nowhere for the value to go,
 * because the credential-delivery capability is disabled and no environment
 * overlay exists. It exists for the key store's own round-trip tests and for
 * readability checks that distinguish "no record" from "unreadable record".
 */
export function readAuditedCodexProviderKey(): string {
  if (cachedProviderKey !== null) {
    return cachedProviderKey
  }

  const keyPath = getProviderKeyPath()
  if (!existsSync(keyPath)) {
    throw new Error('Audited Workflow Codex provider API key is not configured')
  }
  try {
    const raw = readFileSync(keyPath)
    cachedProviderKey = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8')
    return cachedProviderKey
  } catch {
    throw new Error('Audited Workflow Codex provider API key could not be decrypted')
  }
}

// DELIBERATELY ABSENT: a "is the record readable?" helper.
//
// Distinguishing "configured but corrupt" from "configured" requires DECRYPTING
// the key, and while credential delivery is disabled no admission or launch path
// may read the secret value — not even to throw it away. An earlier revision had
// such a helper and called it from plan-audit preflight, which decrypted the key
// on every audit for the sole purpose of choosing between two refusal codes.
// That is a strictly worse trade: a real secret read to improve an error
// message. Tranche 1 therefore branches on opaque record PRESENCE only.

/**
 * Removes the key record. Because selection is derived from that record,
 * clearing it also returns the task to default-provider behaviour — one write,
 * one observable outcome.
 */
export function clearAuditedCodexProviderKey(): void {
  cachedProviderKey = null
  rmSync(getProviderKeyPath(), { force: true })
}

/** Test seam: drops the in-memory cache so a suite can observe disk state. */
export function resetAuditedCodexProviderKeyCacheForTests(): void {
  cachedProviderKey = null
}
