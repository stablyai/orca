import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const packageName = 'com.stably.orca.mobile'
const cacheRoot = 'no_backup/OrcaMobileWeb'
const generationLimit = 16
const buildIdPattern = /^[a-f0-9]{64}$/

/**
 * A host keeps exactly one committed generation, so the directory under `generations/` is the
 * activation record; there is no separate file to read.
 */
export async function readAndroidCommittedGenerations(command, runAdb = runAndroidAdb) {
  const output = await runAdb(command, [
    'shell',
    'run-as',
    packageName,
    'find',
    cacheRoot,
    '-mindepth',
    '3',
    '-maxdepth',
    '3',
    '-type',
    'd',
    '-path',
    `${cacheRoot}/*/generations/*`
  ])
  const paths = output.split(/\r?\n/u).filter(Boolean)
  if (paths.length > generationLimit) {
    throw new Error('Android cache returned too many committed generations')
  }
  return paths.map(parseAndroidGenerationPath)
}

export async function readSingleAndroidGeneration(command, runAdb = runAndroidAdb) {
  const records = await readAndroidCommittedGenerations(command, runAdb)
  if (records.length !== 1) {
    throw new Error(`Expected one Android committed generation, found ${records.length}`)
  }
  return records[0]
}

export async function waitForAndroidCommittedGeneration(
  command,
  expectedBuildId,
  timeoutMs,
  runAdb = runAndroidAdb
) {
  const deadline = Date.now() + timeoutMs
  let records = []
  while (Date.now() < deadline) {
    records = await readAndroidCommittedGenerations(command, runAdb)
    const match = records.find((record) => record.buildId === expectedBuildId)
    if (match) {
      return match
    }
    await delay(100)
  }
  throw new Error(
    `Android generation did not commit: ${expectedBuildId}; records=${JSON.stringify(records)}`
  )
}

export function parseAndroidGenerationPath(value) {
  const segments = value.split('/')
  const buildId = segments.at(-1)
  const hostIdentity = segments.at(-3)
  if (!buildIdPattern.test(buildId ?? '') || !buildIdPattern.test(hostIdentity ?? '')) {
    throw new Error('Android cache returned an invalid generation path')
  }
  return { path: value, hostIdentity, buildId }
}

export async function runAndroidAdb(command, args, timeoutMs = 30_000) {
  const result = await execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: timeoutMs
  })
  return result.stdout.trim()
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
