import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const packageName = 'com.stably.orca.mobile'
const cacheRoot = 'no_backup/OrcaMobileWeb'
const activationLimit = 16
const buildIdPattern = /^[a-f0-9]{64}$/

export async function readAndroidMobileWebActivations(command, runAdb = runAndroidAdb) {
  const output = await runAdb(command, [
    'shell',
    'run-as',
    packageName,
    'find',
    cacheRoot,
    '-name',
    'activation.json',
    '-type',
    'f'
  ])
  const paths = output.split(/\r?\n/u).filter(Boolean)
  if (paths.length > activationLimit) {
    throw new Error('Android cache returned too many activation records')
  }
  return Promise.all(
    paths.map(async (path) => ({
      path,
      ...parseAndroidMobileWebActivation(
        await runAdb(command, ['shell', 'run-as', packageName, 'cat', path])
      )
    }))
  )
}

export async function readAndroidRollbackActivation(command, runAdb = runAndroidAdb) {
  const records = await readAndroidMobileWebActivations(command, runAdb)
  const candidates = records.filter((record) => record.previous)
  if (candidates.length !== 1) {
    throw new Error(`Expected one Android rollback candidate, found ${candidates.length}`)
  }
  return candidates[0]
}

export async function readSingleAndroidActivation(command, runAdb = runAndroidAdb) {
  const records = await readAndroidMobileWebActivations(command, runAdb)
  if (records.length !== 1) {
    throw new Error(`Expected one Android activation record, found ${records.length}`)
  }
  return records[0]
}

export async function waitForAndroidActivation(
  command,
  path,
  expectedBuildId,
  timeoutMs,
  runAdb = runAndroidAdb
) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = parseAndroidMobileWebActivation(
      await runAdb(command, ['shell', 'run-as', packageName, 'cat', path])
    )
    if (last.active === expectedBuildId) {
      return last
    }
    await delay(100)
  }
  throw new Error(`Android activation did not change: ${JSON.stringify(last)}`)
}

export function parseAndroidMobileWebActivation(value) {
  const parsed = JSON.parse(value)
  const previous = parsed?.previous ?? null
  if (
    !buildIdPattern.test(parsed?.active) ||
    (previous !== null && !buildIdPattern.test(previous))
  ) {
    throw new Error('Android cache returned an invalid activation record')
  }
  return { active: parsed.active, previous }
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
