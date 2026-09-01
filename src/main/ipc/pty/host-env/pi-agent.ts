import {
  getCommandTokenPathBasename,
  getFirstCommandToken
} from '../../../../shared/command-token-scanner'
import {
  PRIMARY_AGENT_DIR_ENV_BY_KIND,
  SOURCE_AGENT_DIR_ENV_BY_KIND,
  type PiAgentKind
} from '../../../../shared/pi-agent-kind'
import { readSessionShellStartupEnvVar } from '../../../pty/shell-startup-env'
import { AGENT_HOOK_RUNTIME_ENV_KEYS, CLAUDE_CHILD_SESSION_STAMP_ENV_KEYS } from './spawn-env-keys'

export function readEnvWithProcessFallback(
  baseEnv: Record<string, string>,
  key: string
): string | undefined {
  return baseEnv[key] ?? process.env[key]
}

export function resolvePiAgentSourceDir(
  baseEnv: Record<string, string>,
  kind: PiAgentKind
): string | undefined {
  const sourceKey = SOURCE_AGENT_DIR_ENV_BY_KIND[kind]
  const primaryKey = PRIMARY_AGENT_DIR_ENV_BY_KIND[kind]

  const sourceDir = readEnvWithProcessFallback(baseEnv, sourceKey)
  if (sourceDir) {
    return sourceDir
  }

  if (kind === 'prime-agent') {
    return (
      readEnvWithProcessFallback(baseEnv, primaryKey) ??
      readSessionShellStartupEnvVar(primaryKey, baseEnv)
    )
  }

  const overlayKey = kind === 'omp' ? 'ORCA_OMP_CODING_AGENT_DIR' : 'ORCA_PI_CODING_AGENT_DIR'
  const otherOverlayKey = kind === 'omp' ? 'ORCA_PI_CODING_AGENT_DIR' : 'ORCA_OMP_CODING_AGENT_DIR'

  const publicDir = readEnvWithProcessFallback(baseEnv, primaryKey)
  const ownOverlayDir = readEnvWithProcessFallback(baseEnv, overlayKey)
  const otherOverlayDir = readEnvWithProcessFallback(baseEnv, otherOverlayKey)
  // Why: if PI_CODING_AGENT_DIR is a restored Orca overlay with no source shadow, remirroring leaks another agent's overlay tree; fall through to defaults.
  if (publicDir && publicDir !== ownOverlayDir && publicDir !== otherOverlayDir) {
    return publicDir
  }

  return readSessionShellStartupEnvVar(primaryKey, baseEnv)
}

export function resolveScopedPiAgentSourceDir(
  baseEnv: Record<string, string>,
  kind: PiAgentKind
): string | undefined {
  return readEnvWithProcessFallback(baseEnv, SOURCE_AGENT_DIR_ENV_BY_KIND[kind])
}

export function clearPiAgentShadowEnv(baseEnv: Record<string, string>, kind: PiAgentKind): void {
  if (kind === 'omp') {
    delete baseEnv.ORCA_OMP_CODING_AGENT_DIR
    delete baseEnv.ORCA_OMP_SOURCE_AGENT_DIR
    delete baseEnv.ORCA_OMP_STATUS_EXTENSION
    return
  }
  if (kind === 'prime-agent') {
    delete baseEnv.ORCA_PRIME_AGENT_SOURCE_AGENT_DIR
    delete baseEnv.ORCA_PRIME_AGENT_STATUS_EXTENSION
    return
  }
  delete baseEnv.ORCA_PI_CODING_AGENT_DIR
  delete baseEnv.ORCA_PI_SOURCE_AGENT_DIR
}

export function exposePiManagedExtensionEnv(
  baseEnv: Record<string, string>,
  kind: PiAgentKind,
  managedEnv: Record<string, string>
): void {
  if (kind === 'omp') {
    delete baseEnv.ORCA_OMP_CODING_AGENT_DIR
    if (managedEnv.ORCA_OMP_SOURCE_AGENT_DIR) {
      baseEnv.ORCA_OMP_SOURCE_AGENT_DIR = managedEnv.ORCA_OMP_SOURCE_AGENT_DIR
    } else {
      delete baseEnv.ORCA_OMP_SOURCE_AGENT_DIR
    }
    if (managedEnv.ORCA_OMP_STATUS_EXTENSION) {
      baseEnv.ORCA_OMP_STATUS_EXTENSION = managedEnv.ORCA_OMP_STATUS_EXTENSION
    } else {
      delete baseEnv.ORCA_OMP_STATUS_EXTENSION
    }
    return
  }
  if (kind === 'prime-agent') {
    if (managedEnv.ORCA_PRIME_AGENT_SOURCE_AGENT_DIR) {
      baseEnv.ORCA_PRIME_AGENT_SOURCE_AGENT_DIR = managedEnv.ORCA_PRIME_AGENT_SOURCE_AGENT_DIR
    } else {
      delete baseEnv.ORCA_PRIME_AGENT_SOURCE_AGENT_DIR
    }
    return
  }
  delete baseEnv.ORCA_PI_CODING_AGENT_DIR
  if (managedEnv.ORCA_PI_SOURCE_AGENT_DIR) {
    baseEnv.ORCA_PI_SOURCE_AGENT_DIR = managedEnv.ORCA_PI_SOURCE_AGENT_DIR
  } else {
    delete baseEnv.ORCA_PI_SOURCE_AGENT_DIR
  }
}

// Why: variadic because a nested call per source made intermediate `string[] | undefined` collide with the parameter type.
export function mergePtyEnvDeletions(
  existingKeys: string[] | undefined,
  ...additionalKeyGroups: readonly (readonly string[])[]
): string[] | undefined {
  if (!existingKeys && additionalKeyGroups.every((keys) => keys.length === 0)) {
    return undefined
  }
  return Array.from(new Set([...(existingKeys ?? []), ...additionalKeyGroups.flat()]))
}

export function removeCodexHomeDeletionRequests(keys: string[] | undefined): string[] | undefined {
  // Why: resume provenance is launch-authoritative; late deletions must not fall back to the current account.
  const filtered = keys?.filter((key) => key !== 'CODEX_HOME' && key !== 'ORCA_CODEX_HOME')
  return filtered?.length ? filtered : undefined
}

export function getInheritedAgentHookEnvKeysToDelete(
  spawnEnv: Record<string, string> | undefined
): string[] {
  const env = spawnEnv ?? {}
  // Why: providers merge process.env after cleanup; delete stale hook keys without dropping fresh coordinates buildPtyHostEnv set.
  return AGENT_HOOK_RUNTIME_ENV_KEYS.filter((key) => env[key] === undefined)
}

export function getInheritedClaudeSessionStampEnvKeysToDelete(
  spawnEnv: Record<string, string> | undefined
): string[] {
  const env = spawnEnv ?? {}
  // Why: strip only values inherited from the pty host; a caller that explicitly
  // provides a stamp (deliberately spawning a nested Claude child) keeps it.
  return CLAUDE_CHILD_SESSION_STAMP_ENV_KEYS.filter((key) => env[key] === undefined)
}

// Why: a nested terminal can inherit prior OpenCode/Pi/OMP overlay env; restore the user's recorded source dir, else strip only Orca-owned values.
export function restoreOrStripOverlayEnv(
  baseEnv: Record<string, string>,
  keys: {
    primary: string
    overlay: string
    source: string
  }
): void {
  const sourceValue = baseEnv[keys.source] ?? process.env[keys.source]
  const overlayValue = baseEnv[keys.overlay] ?? process.env[keys.overlay]
  if (sourceValue) {
    baseEnv[keys.primary] = sourceValue
  } else if (overlayValue && baseEnv[keys.primary] === overlayValue) {
    delete baseEnv[keys.primary]
  }
  delete baseEnv[keys.overlay]
  delete baseEnv[keys.source]
}

export function isMimoLaunchCommand(launchCommand: string | undefined): boolean {
  const binary = getCommandTokenPathBasename(getFirstCommandToken(launchCommand ?? ''))
    .toLowerCase()
    .replace(/\.(?:cmd|exe|sh)$/, '')
  return binary === 'mimo'
}

export function resolveMimocodeSourceHome(baseEnv: Record<string, string>): string | undefined {
  const sourceHome = baseEnv.ORCA_MIMOCODE_SOURCE_HOME ?? process.env.ORCA_MIMOCODE_SOURCE_HOME
  if (sourceHome) {
    return sourceHome
  }
  const configHome = baseEnv.MIMOCODE_HOME ?? process.env.MIMOCODE_HOME
  const orcaHome = baseEnv.ORCA_MIMOCODE_HOME ?? process.env.ORCA_MIMOCODE_HOME
  if (configHome && orcaHome && configHome === orcaHome) {
    return undefined
  }
  return configHome
}

export function resolveOpenCodeSourceConfigDir(
  baseEnv: Record<string, string>
): string | undefined {
  const sourceDir =
    baseEnv.ORCA_OPENCODE_SOURCE_CONFIG_DIR ?? process.env.ORCA_OPENCODE_SOURCE_CONFIG_DIR
  if (sourceDir) {
    return sourceDir
  }

  const configDir = baseEnv.OPENCODE_CONFIG_DIR ?? process.env.OPENCODE_CONFIG_DIR
  const orcaConfigDir = baseEnv.ORCA_OPENCODE_CONFIG_DIR ?? process.env.ORCA_OPENCODE_CONFIG_DIR
  // Why: with no recorded source dir, an inherited OPENCODE_CONFIG_DIR is Orca-owned, not user config; treating it as user config makes child Orcas mirror the hook dir.
  if (configDir && orcaConfigDir && configDir === orcaConfigDir) {
    return undefined
  }

  return configDir ?? readSessionShellStartupEnvVar('OPENCODE_CONFIG_DIR', baseEnv)
}
