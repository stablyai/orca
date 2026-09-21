import { resolve } from 'node:path'
import { claudeConfigDirKeychainAliases } from '../claude-accounts/keychain'

/** Case-folded wherever the filesystem is: a spelling difference on macOS or Windows names one
 *  directory, and refusing it blocks work the binding was meant to allow. Linux stays
 *  case-sensitive, where `.Claude` and `.claude` really are two directories. */
function comparablePath(value: string, platform: NodeJS.Platform): string {
  const resolved = resolve(value.trim())
  return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved
}

/**
 * The one answer to "are these two spellings the same config dir", for the whole unit: the pin's
 * default-home test and every refusal check share it, so a no-op binding cannot read as a custom
 * home on one code path and as the shared home on another.
 *
 * Alias-aware, through the same realpath expansion the Keychain lookup uses: macOS `/tmp` is
 * `/private/tmp`, so two spellings of one directory must not read as two homes. That touches the
 * filesystem, which is why this lives in the main process only; it runs on launch paths, never in
 * a loop, and answers without throwing for any string (including the `//`-rooted bindings U1
 * accepts).
 */
export function sameClaudeConfigDir(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const leftAliases = new Set(
    claudeConfigDirKeychainAliases(left.trim()).map((alias) => comparablePath(alias, platform))
  )
  return claudeConfigDirKeychainAliases(right.trim()).some((alias) =>
    leftAliases.has(comparablePath(alias, platform))
  )
}
