import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { getOpenCodePluginSource } from '../opencode/hook-service'
import {
  WSL_HOOK_RELAY_INSTANCE_ENV,
  wslHookRelayEndpointFilePath
} from '../../shared/wsl-hook-relay-contract'
import {
  ORCA_WSL_OPENCODE_MATERIALIZER_ENV,
  ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV
} from './wsl-orca-env'

const OPENCODE_PLUGIN_FILE = 'orca-opencode-status.js'
const WSL_OPENCODE_MATERIALIZER_DIR = 'wsl-opencode-materializer'
const WSL_OPENCODE_MATERIALIZER_FILE = 'materialize.sh'
const HOST_OPENCODE_OVERLAY_ENV_KEYS = [
  'OPENCODE_CONFIG_DIR',
  'ORCA_OPENCODE_CONFIG_DIR',
  'ORCA_OPENCODE_SOURCE_CONFIG_DIR',
  ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV,
  ORCA_WSL_OPENCODE_MATERIALIZER_ENV
] as const

function isGuestPosixConfigDir(value: string | undefined): value is string {
  // Why: Windows drive/UNC paths must never become guest config roots. A
  // single leading slash is the only unambiguous host-side guest path shape.
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
}

function resolveGuestSourceConfigDir(
  env: Record<string, string>,
  inheritedSourceConfigDir?: string
): string | undefined {
  const forwardedSource = env[ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV]
  if (isGuestPosixConfigDir(forwardedSource)) {
    return forwardedSource
  }
  if (isGuestPosixConfigDir(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR)) {
    return env.ORCA_OPENCODE_SOURCE_CONFIG_DIR
  }
  const configDir = env.OPENCODE_CONFIG_DIR
  if (configDir !== env.ORCA_OPENCODE_CONFIG_DIR && isGuestPosixConfigDir(configDir)) {
    return configDir
  }
  // Why: daemon spawn requests omit inherited process env; preserve only an
  // already-resolved guest path so Windows/UNC host overlays cannot cross WSL.
  return isGuestPosixConfigDir(inheritedSourceConfigDir) ? inheritedSourceConfigDir : undefined
}

function shellExactSymlinkBlock(indent: string): string[] {
  return [
    `${indent}if [ -e "$__orca_target" ] || [ -L "$__orca_target" ]; then`,
    `${indent}  [ -L "$__orca_target" ] || return 1`,
    `${indent}  __orca_link_value=$(readlink -- "$__orca_target") || return 1`,
    `${indent}  [ "$__orca_link_value" = "$__orca_entry" ] || return 1`,
    `${indent}elif ! ln -s -- "$__orca_entry" "$__orca_target" 2>/dev/null; then`,
    `${indent}  # Why: another first-launch shell may have won the same link race.`,
    `${indent}  [ -L "$__orca_target" ] || return 1`,
    `${indent}  __orca_link_value=$(readlink -- "$__orca_target") || return 1`,
    `${indent}  [ "$__orca_link_value" = "$__orca_entry" ] || return 1`,
    `${indent}fi`
  ]
}

function shellMaterializerSource(pluginSource: string): string {
  const pluginHash = createHash('sha256').update(pluginSource).digest('hex').slice(0, 16)
  const encodedPlugin = Buffer.from(pluginSource, 'utf8').toString('base64')
  const guestEndpointPath = wslHookRelayEndpointFilePath('$__orca_home', '$__orca_instance_key')

  return [
    '# Orca-managed WSL OpenCode materializer. Sourced at a shell-safe startup boundary.',
    '__orca_materialize_wsl_opencode() {',
    `  local __orca_plugin_hash='${pluginHash}'`,
    '  local __orca_home="${HOME:-}"',
    '  local __orca_source_dir=""',
    '  local __orca_mirror_source_dir=""',
    '  local __orca_source_key="default"',
    '  local __orca_default_config_dir=""',
    '  local __orca_source_real=""',
    '  local __orca_default_real=""',
    '  local __orca_overlay_root=""',
    '  local __orca_overlay_dir=""',
    '  local __orca_plugins_dir=""',
    '  local __orca_entry=""',
    '  local __orca_name=""',
    '  local __orca_target=""',
    '  local __orca_tmp=""',
    '  local __orca_link_value=""',
    '  local __orca_instance_key=""',
    '',
    '  case "$__orca_home" in',
    '    /*) ;;',
    '    *) return 1 ;;',
    '  esac',
    '  while [ "$__orca_home" != "/" ] && [ "${__orca_home%/}" != "$__orca_home" ]; do',
    '    __orca_home="${__orca_home%/}"',
    '  done',
    '  [ "$__orca_home" != "/" ] || return 1',
    '  __orca_overlay_root="$__orca_home/.orca-wsl/opencode-config-overlays"',
    '',
    '  # Why: a PTY-scoped guest override outranks rc-file state, while ordinary',
    '  # guest OPENCODE_CONFIG_DIR remains the fallback discovered after startup.',
    `  if [ -n "\${${ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV}:-}" ]; then`,
    `    __orca_source_dir="$${ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV}"`,
    '  elif [ -n "${OPENCODE_CONFIG_DIR:-}" ]; then',
    '    __orca_source_dir="$OPENCODE_CONFIG_DIR"',
    '  fi',
    '  # Why: OPENCODE_CONFIG_DIR is additive to the XDG global root upstream.',
    '  # Mirror only an explicit guest value; mirroring XDG would load user plugins twice.',
    '  if [ -n "$__orca_source_dir" ]; then',
    '    case "$__orca_source_dir" in',
    '      /*) ;;',
    '      *) return 1 ;;',
    '    esac',
    '    [ -d "$__orca_source_dir" ] || return 1',
    '    __orca_default_config_dir="${XDG_CONFIG_HOME:-$__orca_home/.config}"',
    '    case "$__orca_default_config_dir" in',
    '      /*) ;;',
    '      *) __orca_default_config_dir="$__orca_home/.config" ;;',
    '    esac',
    '    while [ "$__orca_default_config_dir" != "/" ] && [ "${__orca_default_config_dir%/}" != "$__orca_default_config_dir" ]; do',
    '      __orca_default_config_dir="${__orca_default_config_dir%/}"',
    '    done',
    '    __orca_default_config_dir="$__orca_default_config_dir/opencode"',
    '    __orca_source_real=$(readlink -f -- "$__orca_source_dir" 2>/dev/null || true)',
    '    __orca_default_real=$(readlink -f -- "$__orca_default_config_dir" 2>/dev/null || true)',
    '    if [ -n "$__orca_source_real" ] && [ "$__orca_source_real" = "$__orca_default_real" ]; then',
    '      # Why: Global.Path.config already loads this root. Keep the Orca',
    '      # overlay plugin-only so the same user config/plugins load once.',
    '      __orca_mirror_source_dir=""',
    '    else',
    '      __orca_mirror_source_dir="$__orca_source_dir"',
    '      __orca_source_key=$(printf \'%s\' "$__orca_source_dir" | cksum | awk \'{print $1 "-" $2}\')',
    '      case "$__orca_source_key" in',
    '        *[!0-9-]*|*-*-*|-*|*-) return 1 ;;',
    '        *-*) ;;',
    '        *) return 1 ;;',
    '      esac',
    '    fi',
    '  fi',
    '',
    '  __orca_overlay_dir="$__orca_overlay_root/${__orca_plugin_hash}-${__orca_source_key}"',
    '  case "$__orca_overlay_dir" in',
    '    "$__orca_overlay_root"/[0-9a-f]*-default|"$__orca_overlay_root"/[0-9a-f]*-[0-9]*-[0-9]*) ;;',
    '    *) return 1 ;;',
    '  esac',
    '  __orca_plugins_dir="$__orca_overlay_dir/plugins"',
    '',
    "  # Why: never follow a pre-created link out of Orca's managed HOME subtree.",
    '  [ ! -L "$__orca_home/.orca-wsl" ] || return 1',
    '  [ ! -L "$__orca_overlay_root" ] || return 1',
    '  [ ! -L "$__orca_overlay_dir" ] || return 1',
    '  [ ! -L "$__orca_plugins_dir" ] || return 1',
    '  mkdir -p "$__orca_plugins_dir" || return 1',
    '  [ -d "$__orca_overlay_root" ] && [ ! -L "$__orca_overlay_root" ] || return 1',
    '  [ -d "$__orca_overlay_dir" ] && [ ! -L "$__orca_overlay_dir" ] || return 1',
    '  [ -d "$__orca_plugins_dir" ] && [ ! -L "$__orca_plugins_dir" ] || return 1',
    '',
    '  if [ -n "${ZSH_VERSION:-}" ]; then',
    '    setopt local_options null_glob',
    '  fi',
    '',
    '  # Why: OpenCode follows plugin symlinks while scanning. Remove only',
    '  # dangling links inside the managed overlay so renamed/deleted user',
    '  # entries cannot remain as stale config or failing plugin imports.',
    '  for __orca_target in "$__orca_overlay_dir"/* "$__orca_overlay_dir"/.[!.]* "$__orca_overlay_dir"/..?* "$__orca_plugins_dir"/* "$__orca_plugins_dir"/.[!.]* "$__orca_plugins_dir"/..?*; do',
    '    [ -L "$__orca_target" ] && [ ! -e "$__orca_target" ] || continue',
    '    command rm -f -- "$__orca_target" || return 1',
    '  done',
    '',
    '  if [ -n "$__orca_mirror_source_dir" ]; then',
    '    for __orca_entry in "$__orca_mirror_source_dir"/* "$__orca_mirror_source_dir"/.[!.]* "$__orca_mirror_source_dir"/..?*; do',
    '      [ -e "$__orca_entry" ] || [ -L "$__orca_entry" ] || continue',
    '      __orca_name="${__orca_entry##*/}"',
    '      if [ "$__orca_name" = "plugins" ]; then',
    '        [ -d "$__orca_entry" ] || return 1',
    '        for __orca_entry in "$__orca_entry"/* "$__orca_entry"/.[!.]* "$__orca_entry"/..?*; do',
    '          [ -e "$__orca_entry" ] || [ -L "$__orca_entry" ] || continue',
    '          __orca_name="${__orca_entry##*/}"',
    `          [ "$__orca_name" = "${OPENCODE_PLUGIN_FILE}" ] && continue`,
    '          __orca_target="$__orca_plugins_dir/$__orca_name"',
    ...shellExactSymlinkBlock('          '),
    '        done',
    '        continue',
    '      fi',
    '      __orca_target="$__orca_overlay_dir/$__orca_name"',
    ...shellExactSymlinkBlock('      '),
    '    done',
    '  fi',
    '',
    `  __orca_tmp="$__orca_plugins_dir/.${OPENCODE_PLUGIN_FILE}.$$.tmp"`,
    '  command rm -f -- "$__orca_tmp" || return 1',
    '  [ ! -e "$__orca_tmp" ] && [ ! -L "$__orca_tmp" ] || return 1',
    '  if ! base64 -d > "$__orca_tmp" <<\'ORCA_OPENCODE_PLUGIN_EOF\'',
    encodedPlugin,
    'ORCA_OPENCODE_PLUGIN_EOF',
    '  then',
    '    command rm -f -- "$__orca_tmp"',
    '    return 1',
    '  fi',
    `  __orca_target="$__orca_plugins_dir/${OPENCODE_PLUGIN_FILE}"`,
    '  if [ -d "$__orca_target" ] && [ ! -L "$__orca_target" ]; then return 1; fi',
    '  command rm -f -- "$__orca_target" || return 1',
    '  if ! command mv -f -- "$__orca_tmp" "$__orca_target"; then',
    '    command rm -f -- "$__orca_tmp"',
    '    return 1',
    '  fi',
    '',
    `  __orca_instance_key="\${${WSL_HOOK_RELAY_INSTANCE_ENV}:-}"`,
    '  case "$__orca_instance_key" in',
    '    [a-z0-9]*)',
    '      case "$__orca_instance_key" in',
    '        *[!a-z0-9-]*) ;;',
    '        *)',
    '          if [ "${#__orca_instance_key}" -le 64 ]; then',
    '            # Why: the relay writes this deterministic guest file asynchronously.',
    '            # OpenCode retries and re-reads it, covering the first-PTY fallback port.',
    `            export ORCA_AGENT_HOOK_ENDPOINT="${guestEndpointPath}"`,
    '          fi',
    '          ;;',
    '      esac',
    '      ;;',
    '  esac',
    '',
    '  # Why: export only after the plugin write succeeds. A partial/failed',
    "  # materialization leaves the user's guest config untouched and OpenCode usable.",
    '  if [ -n "$__orca_source_dir" ]; then',
    '    export ORCA_OPENCODE_SOURCE_CONFIG_DIR="$__orca_source_dir"',
    '  else',
    '    unset ORCA_OPENCODE_SOURCE_CONFIG_DIR',
    '  fi',
    '  export OPENCODE_CONFIG_DIR="$__orca_overlay_dir"',
    '  export ORCA_OPENCODE_CONFIG_DIR="$__orca_overlay_dir"',
    '}',
    '',
    '__orca_materialize_wsl_opencode || true',
    'unset -f __orca_materialize_wsl_opencode',
    ''
  ].join('\n')
}

function writeIfChanged(path: string, content: string): void {
  let targetExists = false
  try {
    // Why: an equal-content symlink must not bypass the managed host boundary.
    if (!lstatSync(path).isFile()) {
      throw new Error(`WSL OpenCode materializer target is not a regular file: ${path}`)
    }
    targetExists = true
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
  }

  if (targetExists) {
    try {
      if (readFileSync(path, 'utf8') === content) {
        return
      }
    } catch {
      // An unreadable regular file falls through so the write reports the useful error.
    }
  }
  // Why: Windows cannot reliably rename over an existing file. A direct
  // rewrite preserves its ACL/mode and heals stale cached materializers.
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 })
}

export function materializeWslOpenCodeShellScript(userDataPath: string): string | null {
  const targetDir = join(userDataPath, WSL_OPENCODE_MATERIALIZER_DIR)
  const targetPath = join(targetDir, WSL_OPENCODE_MATERIALIZER_FILE)
  try {
    mkdirSync(targetDir, { recursive: true, mode: 0o700 })
    writeIfChanged(targetPath, shellMaterializerSource(getOpenCodePluginSource()))
    return targetPath
  } catch (error) {
    console.warn(
      `[opencode] WSL materializer unavailable: ${error instanceof Error ? error.message : String(error)}`
    )
    return null
  }
}

export function configureWslOpenCodeShellMaterializer(
  env: Record<string, string>,
  userDataPath: string,
  inheritedSourceConfigDir?: string
): void {
  const guestSourceConfigDir = resolveGuestSourceConfigDir(env, inheritedSourceConfigDir)
  // Why: Windows overlays contain host paths and runtime files. WSL builds
  // its equivalent only after guest startup files reveal the guest config.
  for (const key of HOST_OPENCODE_OVERLAY_ENV_KEYS) {
    delete env[key]
  }

  const materializerPath = materializeWslOpenCodeShellScript(userDataPath)
  if (materializerPath) {
    env[ORCA_WSL_OPENCODE_MATERIALIZER_ENV] = materializerPath
    if (guestSourceConfigDir) {
      env[ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV] = guestSourceConfigDir
    }
  } else if (guestSourceConfigDir) {
    // Why: a missing Orca script must not also discard the user's explicit
    // guest config; an existing OPENCODE_CONFIG_DIR/u WSLENV entry can still cross.
    env.OPENCODE_CONFIG_DIR = guestSourceConfigDir
  }
}

export const _internals = {
  resolveGuestSourceConfigDir,
  shellMaterializerSource,
  writeIfChanged
}
