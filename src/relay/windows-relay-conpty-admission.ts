import { realpathSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { resolveWindowsConptyProvider } from '../main/windows/windows-conpty-provider'
import { normalizeRuntimePathForComparison } from '../shared/cross-platform-path'
import type { RelayLaunchOptions } from './relay-launch-options'

/** The native provider reads the initial environment; changing process.env here is too late. */
export function assertWindowsRelayConptyProvider(
  options: Pick<RelayLaunchOptions, 'connectMode' | 'cliMode'>
): void {
  if (process.platform !== 'win32' || options.connectMode || options.cliMode) {
    return
  }
  const entry = process.argv[1]
  const selector = process.env.BUN_CONPTY_LIBRARY
  if (!entry || !selector || !isAbsolute(selector)) {
    throw new Error(
      'Windows relay requires its bundled terminal provider. Launch through Orca SSH deployment, ' +
        'or set BUN_CONPTY_LIBRARY to the absolute adjacent conpty.dll path before starting Bun.'
    )
  }
  const expected = resolveWindowsConptyProvider(dirname(realpathSync(entry)), process.arch)
  if (
    normalizeRuntimePathForComparison(realpathSync(selector)) !==
    normalizeRuntimePathForComparison(realpathSync(expected))
  ) {
    throw new Error('Windows relay terminal provider must belong to this relay installation')
  }
}
