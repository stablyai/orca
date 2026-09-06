import { open, readdir } from 'node:fs/promises'
import path from 'node:path'

const ACTIVATION_BYTE_LIMIT = 4 * 1024
const HOST_DIRECTORY_LIMIT = 16
const identityPattern = /^[a-f0-9]{64}$/

export async function readIosRollbackActivation(appDataPath) {
  const records = await readIosActivationRecords(appDataPath)
  const candidates = records.filter((record) => record.previous)
  if (candidates.length !== 1) {
    throw new Error(`Expected one iOS rollback candidate, found ${candidates.length}`)
  }
  return candidates[0]
}

export async function readIosActivationRecords(appDataPath) {
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
    const activationPath = path.join(cacheRoot, entry.name, 'activation.json')
    try {
      records.push({
        path: activationPath,
        ...(await readIosActivation(activationPath))
      })
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error
      }
    }
  }
  return records
}

export async function waitForIosActivation(pathname, expectedBuildId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await readIosActivation(pathname)
    if (last.active === expectedBuildId) {
      return last
    }
    await delay(100)
  }
  throw new Error(`iOS activation did not roll back: ${JSON.stringify(last)}`)
}

export async function readIosActivation(pathname) {
  const file = await open(pathname, 'r')
  try {
    const bytes = Buffer.alloc(ACTIVATION_BYTE_LIMIT + 1)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > ACTIVATION_BYTE_LIMIT) {
      throw new Error('iOS activation record exceeded its size limit')
    }
    const parsed = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
    const previous = parsed?.previous ?? null
    if (
      !identityPattern.test(parsed?.active) ||
      (previous !== null && !identityPattern.test(previous))
    ) {
      throw new Error('iOS cache returned an invalid activation record')
    }
    return { active: parsed.active, previous }
  } finally {
    await file.close()
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
