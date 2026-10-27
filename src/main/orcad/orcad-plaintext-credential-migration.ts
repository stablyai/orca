// Seal legacy integration credentials after key loading; gh/glab own their tokens separately.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SecretStore } from '../../shared/secret-store'
import { classifyUnenvelopedCredential } from '../../shared/secret-at-rest-protection'
import { hardenExistingSecureFile, writeSecureFile } from '../../shared/secure-file'
import { writeCredentialFileAtomic } from '../integration-credential-file'
import {
  getWorkspaceTokenDir,
  getWorkspaceTokenPath,
  LEGACY_WORKSPACE_ID
} from '../linear/linear-credential-paths'
import { getTokenDir as getJiraTokenDir } from '../jira/site-credential-store'
import { getSecretPath as getBitbucketSecretPath } from '../bitbucket/credential-store'
import { getOpenAiKeyPath } from '../speech/openai-api-key-store'
import { API_KEY_ENVELOPE_PREFIX, getZcodePlanApiKeyPath } from '../zcode/zcode-plan-api-key-store'
import { COOKIE_ENVELOPE_PREFIX, getMiniMaxCookiePath } from '../minimax/minimax-cookie-store'
import { miniMaxApiKeyEnvelopeFile } from '../minimax/minimax-api-key-store'
import { openCodeGoApiKeyEnvelopeFile } from '../opencode/opencode-go-api-key-store'

type PlaintextCredentialTarget = {
  path: string
  envelopePrefix?: string
  /** Legacy files can contain bare credentials without an envelope. */
  raw?: boolean
}

type PlaintextCredentialMigrationResult = { sealed: number; failed: number }

function encFilesIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.enc'))
      .map((name) => join(dir, name))
  } catch {
    return []
  }
}

/** Keep credentials outside disposable ORCA_USER_DATA roots. */
export function orcadCredentialRoot(): string {
  return join(homedir(), '.orca')
}

function listPlaintextCredentialTargets(): PlaintextCredentialTarget[] {
  return [
    { path: getWorkspaceTokenPath(LEGACY_WORKSPACE_ID), raw: true },
    ...encFilesIn(getWorkspaceTokenDir()).map((path) => ({ path, raw: true })),
    ...encFilesIn(getJiraTokenDir()).map((path) => ({ path, raw: true })),
    { path: getBitbucketSecretPath(), raw: true },
    { path: getOpenAiKeyPath(), raw: true },
    { path: getMiniMaxCookiePath(), envelopePrefix: COOKIE_ENVELOPE_PREFIX, raw: true },
    { path: getZcodePlanApiKeyPath(), envelopePrefix: API_KEY_ENVELOPE_PREFIX },
    miniMaxApiKeyEnvelopeFile(),
    openCodeGoApiKeyEnvelopeFile()
  ]
}

function sealTarget(store: SecretStore, target: PlaintextCredentialTarget): boolean {
  const original = readFileSync(target.path)
  // Restrict permissions even when sealing fails.
  hardenExistingSecureFile(target.path)
  const unchanged = (): boolean => readFileSync(target.path).equals(original)
  const text = original.toString('utf8')
  if (target.envelopePrefix && text.startsWith(target.envelopePrefix)) {
    const plaintextTag = `${target.envelopePrefix}plaintext:`
    if (!text.startsWith(plaintextTag)) {
      return false
    }
    const value = Buffer.from(text.slice(plaintextTag.length), 'base64').toString('utf8')
    if (!value) {
      return false
    }
    const sealed = store.encryptString(value)
    if (store.decryptString(sealed) !== value) {
      throw new Error('sealed value did not read back')
    }
    const envelope = `${target.envelopePrefix}encrypted:${sealed.toString('base64')}`
    return writeSecureFile(target.path, envelope, { durable: true, shouldPublish: unchanged })
  }
  // Old speech JSON may already wrap a sealed key.
  if (
    !target.raw ||
    original.length === 0 ||
    classifyUnenvelopedCredential(original) !== 'plaintext' ||
    (target.path === getOpenAiKeyPath() && text.trimStart().startsWith('{'))
  ) {
    return false
  }
  const sealed = store.encryptString(text)
  if (store.decryptString(sealed) !== text) {
    throw new Error('sealed value did not read back')
  }
  // Preserve concurrent desktop saves to the shared credential directory.
  const published = writeCredentialFileAtomic(target.path, sealed, unchanged)
  if (published) {
    hardenExistingSecureFile(target.path)
  }
  return published
}

/** Never log credential contents or replace bytes when sealing fails. */
export function migratePlaintextCredentials(
  store: SecretStore,
  targets: readonly PlaintextCredentialTarget[] = listPlaintextCredentialTargets(),
  log: (message: string) => void = (message) => console.warn(message)
): PlaintextCredentialMigrationResult {
  const result: PlaintextCredentialMigrationResult = { sealed: 0, failed: 0 }
  for (const target of targets) {
    if (!existsSync(target.path)) {
      continue
    }
    try {
      if (sealTarget(store, target)) {
        result.sealed += 1
      }
    } catch (error) {
      result.failed += 1
      log(
        `[secrets] could not seal ${target.path}; left unchanged: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
  if (result.sealed > 0) {
    log(
      `[secrets] sealed ${result.sealed} credential file(s) that an older server stored in plaintext`
    )
  }
  return result
}
