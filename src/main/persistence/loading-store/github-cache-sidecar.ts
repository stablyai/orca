import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { getGithubCacheFile } from './user-data-path'

type GitHubCache = PersistedState['githubCache']

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * The JSON sidecar older builds write, parsed and fingerprinted from one read of its bytes, so a
 * concurrent replacement can never pair one file's content with another's fingerprint.
 * Missing or unparsable sidecars read as null, as they always have.
 */
export function readGitHubCacheSidecar(dataFile: string): GitHubCacheSidecar | null {
  let bytes: Buffer
  try {
    // One-shot: the synchronous profile load reads this once at startup.
    bytes = readFileSync(getGithubCacheFile(dataFile))
  } catch {
    return null
  }
  return parseGitHubCacheSidecar(bytes)
}

/** Remove the sidecar off the save path, only if it is still the file the rows superseded. */
export async function retireGitHubCacheSidecar(dataFile: string, hash: string): Promise<void> {
  const path = getGithubCacheFile(dataFile)
  const bytes = await readFile(path).catch(() => null)
  if (bytes && parseGitHubCacheSidecar(bytes)?.hash === hash) {
    await rm(path, { force: true })
  }
}

type GitHubCacheSidecar = { cache: GitHubCache; hash: string }

function parseGitHubCacheSidecar(bytes: Buffer): GitHubCacheSidecar | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf-8'))
  } catch {
    return null
  }
  if (!isRecord(parsed) || !isRecord(parsed.pr) || !isRecord(parsed.issue)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same shape check the sidecar reader always applied; entries stay opaque cache payloads.
  return { cache: parsed as GitHubCache, hash: sha256(bytes) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
