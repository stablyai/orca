import { readdir } from 'node:fs/promises'
import path from 'node:path'

const HOST_DIRECTORY_LIMIT = 16
const identityPattern = /^[a-f0-9]{64}$/

/**
 * A host keeps exactly one committed generation, so the directory under `generations/` is the
 * activation record; there is no separate file to read.
 */
export async function readIosCommittedGenerations(appDataPath) {
  const cacheRoot = path.join(appDataPath, 'Library', 'Application Support', 'OrcaMobileWeb')
  const entries = await readdir(cacheRoot, { withFileTypes: true })
  if (entries.length > HOST_DIRECTORY_LIMIT) {
    throw new Error('iOS cache returned too many host directories')
  }
  const records = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !identityPattern.test(entry.name)) {
      continue
    }
    const hostRoot = path.join(cacheRoot, entry.name)
    const buildId = await readCommittedBuildId(hostRoot)
    if (buildId) {
      records.push({ hostIdentity: entry.name, path: hostRoot, buildId })
    }
  }
  return records
}

export async function waitForIosCommittedGeneration(appDataPath, expectedBuildId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let records = []
  while (Date.now() < deadline) {
    records = await readIosCommittedGenerations(appDataPath)
    const match = records.find((record) => record.buildId === expectedBuildId)
    if (match) {
      return match
    }
    await delay(100)
  }
  throw new Error(
    `iOS generation did not commit: ${expectedBuildId}; records=${JSON.stringify(records)}`
  )
}

export async function readCommittedBuildId(hostRoot) {
  let entries
  try {
    entries = await readdir(path.join(hostRoot, 'generations'), { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null
    }
    throw error
  }
  const committed = entries.filter(
    (entry) => entry.isDirectory() && identityPattern.test(entry.name)
  )
  if (committed.length > 1) {
    throw new Error(`iOS host kept ${committed.length} generations instead of one`)
  }
  return committed[0]?.name ?? null
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
