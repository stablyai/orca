import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DEFAULT_EXPECTED_SIGNER,
  verifyWindowsInnerSignature
} from './verify-windows-inner-signature.mjs'

export const BROKER_RELATIVE_PATH = join('bin', 'orca-pipe-broker.exe')

export function verifyPackagedWindowsRuntimePipeBrokerSignature(resourcesDir, options = {}) {
  if (typeof resourcesDir !== 'string' || resourcesDir.trim() === '') {
    throw new Error('A final packaged resources directory is required.')
  }
  const brokerPath = join(resourcesDir, BROKER_RELATIVE_PATH)
  if (!existsSync(brokerPath) || !statSync(brokerPath).isFile()) {
    throw new Error(`Missing broker from final package payload: ${brokerPath}`)
  }

  const verifySignature = options.verifySignature ?? verifyWindowsInnerSignature
  const signature = verifySignature({
    executablePath: brokerPath,
    platform: options.platform ?? process.platform,
    spawnSyncImpl: options.spawnSyncImpl,
    expectedSigners: options.expectedSigners ?? [DEFAULT_EXPECTED_SIGNER],
    expectedThumbprints: options.expectedThumbprints ?? []
  })
  return { brokerPath, signature }
}

export function main(argv = process.argv.slice(2)) {
  try {
    const result = verifyPackagedWindowsRuntimePipeBrokerSignature(argv[0])
    console.log(`PACKAGED_BROKER_SIGNATURE=PASS PATH=${result.brokerPath}`)
    console.log(`SIGNER=${result.signature.signerSubject}`)
  } catch (error) {
    console.error(`PACKAGED_BROKER_SIGNATURE=FAIL ${error.message}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
