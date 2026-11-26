import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildHostProviderExec, providerExecFingerprint } from './build-provider-exec.mjs'

/** Unpackaged runs accept a current glibc-floor build; replacing it made packaging rebuild it in Docker. */
export function ensureUnpackagedProviderExec(root = resolve(import.meta.dirname, '../../../..')) {
  const target = `${process.platform}-${process.arch}`
  const output = join(root, 'native', 'provider-exec', '.build', target, 'orca-provider-exec')
  const stamp = `${output}.sha256`
  if (
    process.platform === 'linux' &&
    existsSync(output) &&
    existsSync(stamp) &&
    readFileSync(stamp, 'utf8') === providerExecFingerprint(root, target, 'docker')
  ) {
    return output
  }
  return buildHostProviderExec()
}
