import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { readIosActivationRecords } from './hosted-ios-mobile-web-cache.mjs'

const execFileAsync = promisify(execFile)
const IOS_BUNDLE_IDENTIFIER = 'com.stably.orca.mobile'

export async function waitForHostedIosBuildActivation(
  deviceUdid,
  { expectedBuild, timeoutMs },
  runtimeDirectory,
  runCommand = execFileAsync
) {
  if (!expectedBuild) {
    return
  }
  const { stdout } = await runCommand('xcrun', [
    'simctl',
    'get_app_container',
    deviceUdid,
    IOS_BUNDLE_IDENTIFIER,
    'data'
  ])
  const appDataPath = stdout.trim()
  const hostIdentity = await pairedHostCacheIdentity(runtimeDirectory)
  const deadline = Date.now() + timeoutMs
  let records = []
  while (Date.now() < deadline) {
    records = await readIosActivationRecords(appDataPath)
    const expectedPathPart = `${path.sep}${hostIdentity}${path.sep}`
    if (
      records.some(
        (record) => record.active === expectedBuild && record.path.includes(expectedPathPart)
      )
    ) {
      return
    }
    await delay(100)
  }
  throw new Error(
    `Expected iOS build did not activate: ${expectedBuild}; records=${JSON.stringify(records)}`
  )
}

async function pairedHostCacheIdentity(runtimeDirectory) {
  const keypairPath = path.join(
    runtimeDirectory,
    'paired-host',
    'userData',
    'orca-e2ee-keypair.json'
  )
  const keypair = JSON.parse(await readFile(keypairPath, 'utf8'))
  if (typeof keypair.publicKeyB64 !== 'string' || keypair.publicKeyB64.length === 0) {
    throw new Error('Paired-host runtime has no public key')
  }
  return createHash('sha256').update(keypair.publicKeyB64).digest('hex')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
