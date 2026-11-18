import { readdir, readlink, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { MERGE_PENDING_SUFFIX, lstatIfPresent } from '../../../filesystem/merged-directory-link'
import { HISTORY_CLEANUP_MANIFEST, readManifest } from './codex-account-history-cleanup-manifest'
import { WRITER_LOCKS } from './codex-thread-writer-locks'

// Created in the store when missing, so a first account still links its history.
export const STORE_DIRECTORIES = ['sessions', 'archived_sessions', 'rollout-migrations']

// Local logs and scratch; per-home process endpoints (a linked daemon socket would attach an
// account to the ~/.codex login's daemon); state keyed to the home's own path (encrypted secrets
// whose keyring passphrase is named from CODEX_HOME, the Windows sandbox setup); resources Orca
// links or copies itself, including the home's own bundled marketplaces inside `.tmp`.
const PRIVATE_DIRECTORIES = new Set([
  'log',
  'tmp',
  '.tmp',
  'app-server-control',
  'app-server-daemon',
  'ipc',
  'secrets',
  '.sandbox',
  '.sandbox-bin',
  '.sandbox-secrets',
  'skills',
  'hooks',
  'plugins',
  'plugin-state',
  'profile-v2',
  'themes',
  'prompts',
  'rules'
])

export function isSharedDirectoryName(name: string): boolean {
  return (
    !PRIVATE_DIRECTORIES.has(name) &&
    !name.startsWith('.orca') &&
    !name.endsWith(MERGE_PENDING_SUFFIX)
  )
}

export async function readDirectoryEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return []
    }
    throw error
  }
}

/** Every folder of the store or the home is shared; files (login, config, prompt recall) stay. */
export async function sharedDirectoryNames(
  storeHome: string,
  accountHome: string
): Promise<string[]> {
  const names = new Set(STORE_DIRECTORIES)
  for (const home of [storeHome, accountHome]) {
    for (const entry of await readDirectoryEntries(home)) {
      if (entry.isDirectory()) {
        names.add(entry.name)
      }
    }
  }
  names.delete(WRITER_LOCKS)
  return [...names].filter(isSharedDirectoryName)
}

export async function isSameDirectory(left: string, right: string): Promise<boolean> {
  const resolve = (path: string): Promise<string | null> =>
    realpath(path).catch((error: unknown) => {
      if (isDefinitiveAbsence(error)) {
        return null
      }
      throw error
    })
  const [a, b] = await Promise.all([resolve(left), resolve(right)])
  return a !== null && a === b
}

// A link's own text, so a link into a folder that's gone (moved, unmounted) is still recognized.
async function linkTarget(path: string): Promise<string | null> {
  if (!(await lstatIfPresent(path))?.isSymbolicLink()) {
    return null
  }
  // Windows reports a junction's target with the `\\?\` prefix.
  const text = (await readlink(path)).replace(/^\\\\\?\\/, '')
  return resolve(dirname(path), text)
}

function samePath(left: string, right: string): boolean {
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}

/** Whether `path` is a link to `store`'s folder of the same name, even if that folder is gone. */
export async function isLinkInto(path: string, store: string): Promise<boolean> {
  const target = await linkTarget(path)
  return target !== null && samePath(target, join(store, basename(path)))
}

/**
 * The store Orca recorded linking this home into, when the Codex history folder has changed since;
 * null when the home follows `storeHome`, or its lock link points anywhere else (the user's own).
 */
export async function earlierStoreOf(
  accountHome: string,
  storeHome: string
): Promise<string | null> {
  if (!(await lstatIfPresent(join(accountHome, HISTORY_CLEANUP_MANIFEST)))) {
    return null
  }
  const manifest = await readManifest(accountHome).catch(() => null)
  if (!manifest || manifest === 'newer' || typeof manifest.storeHome !== 'string') {
    return null
  }
  const earlier = manifest.storeHome
  const lockTarget = await linkTarget(join(accountHome, WRITER_LOCKS))
  if (
    (lockTarget !== null && !(await isLinkInto(join(accountHome, WRITER_LOCKS), earlier))) ||
    samePath(earlier, storeHome) ||
    (await isSameDirectory(earlier, storeHome))
  ) {
    return null
  }
  return earlier
}

/** The home's links into `store`; a link the user made elsewhere is not among them. */
export async function linksIntoStore(accountHome: string, store: string): Promise<string[]> {
  const links: string[] = []
  for (const entry of await readDirectoryEntries(accountHome)) {
    const path = join(accountHome, entry.name)
    if (
      (isSharedDirectoryName(entry.name) || entry.name === WRITER_LOCKS) &&
      (await isLinkInto(path, store))
    ) {
      links.push(path)
    }
  }
  return links
}
