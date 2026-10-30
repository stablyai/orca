/** Use vendor_conf.d to restore XDG_DATA_DIRS and defer agent hooks until after user config. */
import { getFishCodexShellLaunchPreflight } from '../shared/codex-shell-function'
import { getFishClaudeShellFunction } from '../shared/claude-shell-function'
import { MANAGED_DATA_ACCOUNT_FISH_RESTORE } from '../shared/managed-data-account-shell'
import type { ShellWrapperFile } from './shell-wrapper-file-writer'

/** Exactly what Orca prepended, so the snippet can remove that and nothing else. */
export const FISH_XDG_DATA_DIRS_PREFIX_ENV = 'ORCA_FISH_XDG_DATA_DIRS_PREFIX'

// XDG defaults also apply when fish 4.7+ sees an unset or empty XDG_DATA_DIRS.
const XDG_DATA_DIRS_DEFAULT = '/usr/local/share:/usr/share'

export function getFishXdgDataDir(wrapperRoot: string): string {
  return `${wrapperRoot}/fish-xdg-data`
}

export function getFishVendorConfSnippetPath(wrapperRoot: string): string {
  return `${getFishXdgDataDir(wrapperRoot)}/fish/vendor_conf.d/orca-shell-integration.fish`
}

// No-config flags prevent vendor_conf.d from restoring the handoff environment.
export function fishArgsSkipConfig(fishArgs: readonly string[]): boolean {
  return fishArgs.some(
    (arg) => /^-[^-]*N/.test(arg) || (arg.length > 5 && '--no-config'.startsWith(arg))
  )
}

/** Spawn env that makes fish load the snippet; empty when the snippet could not undo it. */
export function getFishXdgDataDirsLaunchEnv(
  wrapperRoot: string,
  inheritedXdgDataDirs: string | undefined,
  fishArgs: readonly string[] = []
): Record<string, string> {
  const dataDir = getFishXdgDataDir(wrapperRoot)
  if (dataDir.includes(':') || fishArgsSkipConfig(fishArgs)) {
    return {}
  }
  // Empty means XDG defaults in fish 4.7+; older fish gains only those two vendor dirs.
  const prefix = inheritedXdgDataDirs ? dataDir : `${dataDir}:${XDG_DATA_DIRS_DEFAULT}`
  return {
    XDG_DATA_DIRS: inheritedXdgDataDirs ? `${prefix}:${inheritedXdgDataDirs}` : prefix,
    [FISH_XDG_DATA_DIRS_PREFIX_ENV]: prefix
  }
}

// Scope temporary variables to the function; only the restored env and hooks should survive.
// Wait for fish_prompt so user-defined functions and PATH changes take precedence.
export function getFishVendorConfSnippet(): string {
  return `# Orca-generated. Loaded only because Orca put this directory on
# XDG_DATA_DIRS for one fish launch; the first thing it does is take it off.
function __orca_fish_xdg_handoff
    set -q ${FISH_XDG_DATA_DIRS_PREFIX_ENV}; or return 0
    set -l prefix "$${FISH_XDG_DATA_DIRS_PREFIX_ENV}"
    set -e -g ${FISH_XDG_DATA_DIRS_PREFIX_ENV}
    set -l dirs (string replace -- ":$prefix:" : ":$XDG_DATA_DIRS:")
    set dirs (string replace -r -a -- '^:|:$' '' "$dirs")
    if test -n "$dirs"
        set -gx XDG_DATA_DIRS "$dirs"
    else
        set -e -g XDG_DATA_DIRS
    end


    status is-interactive; or return 0
    function __orca_define_codex --on-event fish_prompt
        functions -e __orca_define_codex
${MANAGED_DATA_ACCOUNT_FISH_RESTORE}
${getFishCodexShellLaunchPreflight()}${getFishClaudeShellFunction()}
    end
end
__orca_fish_xdg_handoff
functions -e __orca_fish_xdg_handoff
`
}

export function buildFishVendorConfWrapperFile(wrapperRoot: string): ShellWrapperFile {
  return [getFishVendorConfSnippetPath(wrapperRoot), getFishVendorConfSnippet()]
}
