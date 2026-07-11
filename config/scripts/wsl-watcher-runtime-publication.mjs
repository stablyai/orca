import { readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
export { withRuntimePublicationLock } from './wsl-watcher-runtime-lock.mjs'

const DEFAULT_ARTIFACT_MAX_AGE_MS = 24 * 60 * 60 * 1_000
const defaultOperations = { readdir, rename, rm, stat }

function errorCode(error) {
  return error?.code
}

async function pathExists(filename, operations) {
  try {
    await operations.stat(filename)
    return true
  } catch {
    return false
  }
}

async function artifactDetails(parent, name, operations) {
  const filename = join(parent, name)
  try {
    return { filename, name, modifiedAt: (await operations.stat(filename)).mtimeMs }
  } catch {
    return null
  }
}

export async function recoverAndScavengeRuntimePaths(
  publishedPath,
  validate,
  {
    operations: operationOverrides = {},
    maxArtifactAgeMs = DEFAULT_ARTIFACT_MAX_AGE_MS,
    now = Date.now
  } = {}
) {
  const operations = { ...defaultOperations, ...operationOverrides }
  const parent = dirname(publishedPath)
  const base = basename(publishedPath)
  let names
  try {
    names = await operations.readdir(parent)
  } catch {
    return false
  }
  const details = (
    await Promise.all(
      names
        .filter((name) => name.startsWith(`${base}.backup-`) || name.startsWith(`${base}.stage-`))
        .map((name) => artifactDetails(parent, name, operations))
    )
  ).filter(Boolean)
  let recovered = false
  if (!(await pathExists(publishedPath, operations))) {
    const backups = details
      .filter((entry) => entry.name.startsWith(`${base}.backup-`))
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
    for (const backup of backups) {
      if (await validate(backup.filename)) {
        await operations.rename(backup.filename, publishedPath)
        recovered = true
        break
      }
    }
  }
  for (const artifact of details) {
    if (artifact.filename !== publishedPath && now() - artifact.modifiedAt >= maxArtifactAgeMs) {
      await operations.rm(artifact.filename, { recursive: true, force: true })
    }
  }
  return recovered
}

export async function replacePublishedRuntimePath(
  stagedPath,
  publishedPath,
  backupPath,
  { operations: operationOverrides = {} } = {}
) {
  const operations = { ...defaultOperations, ...operationOverrides }
  let previousMoved = false
  try {
    try {
      await operations.rename(publishedPath, backupPath)
      previousMoved = true
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw error
      }
    }
    await operations.rename(stagedPath, publishedPath)
  } catch (publicationError) {
    if (previousMoved) {
      try {
        await operations.rename(backupPath, publishedPath)
      } catch (rollbackError) {
        throw new AggregateError(
          [publicationError, rollbackError],
          `Failed to publish and roll back WSL watcher runtime at ${publishedPath}`
        )
      }
    }
    throw publicationError
  }

  if (previousMoved) {
    await operations.rm(backupPath, { recursive: true, force: true })
  }
}
