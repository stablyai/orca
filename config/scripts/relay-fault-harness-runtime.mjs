import { join, resolve } from 'node:path'
import { cliRuntimeFilename, verifyCliRuntimeDirectory } from '../bundled-cli-runtime.cjs'
import { bunOwnedRuntimeArgs } from '../../src/shared/bun-owned-runtime-args.ts'

/** The release build already prepares this runtime; the fault gate must never fetch one. */
export function resolveRelayFaultHarnessRuntime(
  root,
  platform = process.platform,
  arch = process.arch
) {
  const directory = resolve(root, 'out', 'cli-runtime', `${platform}-${arch}`)
  try {
    verifyCliRuntimeDirectory(directory, platform, arch)
  } catch (cause) {
    throw new Error(
      `Prepare the bundled CLI runtime for ${platform}-${arch} before the relay fault gate`,
      { cause }
    )
  }
  return {
    executable: join(directory, cliRuntimeFilename(platform)),
    args: bunOwnedRuntimeArgs(platform)
  }
}
