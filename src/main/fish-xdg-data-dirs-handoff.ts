/**
 * Gives a plain fish pane Orca's `codex` function without changing how fish
 * starts: the spawn env prepends an Orca data dir to XDG_DATA_DIRS, fish sources
 * that dir's fish/vendor_conf.d, and the snippet's first act is to undo it.
 */
import { getFishCodexShellLaunchPreflight } from '../shared/codex-shell-function'
import { MANAGED_DATA_ACCOUNT_FISH_RESTORE } from '../shared/managed-data-account-shell'
import type { ShellWrapperFile } from './shell-wrapper-file-writer'

/** Exactly what Orca prepended, so the snippet can remove that and nothing else. */
export const FISH_XDG_DATA_DIRS_PREFIX_ENV = 'ORCA_FISH_XDG_DATA_DIRS_PREFIX'

// Why: the XDG spec default, which fish 4.7+ also scans when XDG_DATA_DIRS is unset or empty.
const XDG_DATA_DIRS_DEFAULT = '/usr/local/share:/usr/share'

export function getFishXdgDataDir(wrapperRoot: string): string {
  return `${wrapperRoot}/fish-xdg-data`
}

export function getFishVendorConfSnippetPath(wrapperRoot: string): string {
  return `${getFishXdgDataDir(wrapperRoot)}/fish/vendor_conf.d/orca-shell-integration.fish`
}

// Why: -N/--no-config (also abbreviated or in a flag cluster) skips vendor_conf.d,
// so the snippet could never undo the env. Over-matching only costs the codex hook.
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
  // Why empty counts as unset: the XDG spec and fish 4.7+ read both as the default; older fish only gains the two default vendor dirs.
  const prefix = inheritedXdgDataDirs ? dataDir : `${dataDir}:${XDG_DATA_DIRS_DEFAULT}`
  return {
    XDG_DATA_DIRS: inheritedXdgDataDirs ? `${prefix}:${inheritedXdgDataDirs}` : prefix,
    [FISH_XDG_DATA_DIRS_PREFIX_ENV]: prefix
  }
}

// Why a function: its variables stay function-scoped, so nothing but the
// restored XDG_DATA_DIRS and the codex hook outlives this file.
// Why codex waits for fish_prompt: config.fish has not run yet, and the user's
// own codex function or PATH entry must be seen first, as in wrapped panes.
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
${getFishCodexShellLaunchPreflight()}
    end
end
__orca_fish_xdg_handoff
functions -e __orca_fish_xdg_handoff
`
}

export function buildFishVendorConfWrapperFile(wrapperRoot: string): ShellWrapperFile {
  return [getFishVendorConfSnippetPath(wrapperRoot), getFishVendorConfSnippet()]
}
