import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  recoverAndScavengeRuntimePaths,
  replacePublishedRuntimePath,
  withRuntimePublicationLock
} from './wsl-watcher-runtime-publication.mjs'

const defaultOperations = { mkdir, readFile, rename, rm, stat, writeFile }

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

async function matchesHash(filename, expected, operations) {
  try {
    return sha256(await operations.readFile(filename)) === expected
  } catch {
    return false
  }
}

export async function downloadRuntimeArchive(
  arch,
  expectedHash,
  nodeVersion,
  defaultCacheDir,
  {
    runtimeCacheDir = defaultCacheDir,
    fetchRuntime = fetch,
    createPublicationId = randomUUID,
    beforeCachePublish,
    runtimeFileOperations: operationOverrides = {},
    cacheLockOptions = {}
  } = {}
) {
  const operations = { ...defaultOperations, ...operationOverrides }
  await operations.mkdir(runtimeCacheDir, { recursive: true })
  const filename = `node-v${nodeVersion}-linux-${arch}.tar.xz`
  const cached = join(runtimeCacheDir, filename)
  const lockPath = `${cached}.publish.lock`
  const validate = (candidate) => matchesHash(candidate, expectedHash, operations)
  await withRuntimePublicationLock(
    lockPath,
    () => recoverAndScavengeRuntimePaths(cached, validate, { operations }),
    { ...cacheLockOptions, operations }
  )
  if (await validate(cached)) {
    return cached
  }

  const response = await fetchRuntime(`https://nodejs.org/dist/v${nodeVersion}/${filename}`, {
    signal: AbortSignal.timeout(60_000)
  })
  if (!response.ok) {
    throw new Error(`Could not download ${filename}: HTTP ${response.status}`)
  }
  const contents = Buffer.from(await response.arrayBuffer())
  const actualHash = sha256(contents)
  if (actualHash !== expectedHash) {
    throw new Error(
      `Checksum mismatch for ${filename}: expected ${expectedHash}, got ${actualHash}`
    )
  }

  const publicationId = createPublicationId()
  const temporary = `${cached}.stage-${publicationId}`
  const backup = `${cached}.backup-${publicationId}`
  try {
    await operations.writeFile(temporary, contents)
    await beforeCachePublish?.({ cached, temporary })
    await withRuntimePublicationLock(
      lockPath,
      async () => {
        await recoverAndScavengeRuntimePaths(cached, validate, { operations })
        // Why: another packager may publish the same verified archive while
        // this download is in flight; never replace that known-good result.
        if (await validate(cached)) {
          return
        }
        await replacePublishedRuntimePath(temporary, cached, backup, { operations })
      },
      { ...cacheLockOptions, operations }
    )
    return cached
  } finally {
    await operations.rm(temporary, { force: true })
  }
}
