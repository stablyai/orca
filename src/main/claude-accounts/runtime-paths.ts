import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeEnvPatch } from './environment'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { getWslHome } from '../wsl'
import { HOST_AUTH_SURFACE_KEY, wslAuthSurfaceKey } from './auth-surface'

export type ClaudeRuntimePaths = {
  surfaceKey: string
  configDir: string
  credentialsPath: string
  configPath: string
  /** Guest-side config dir when the surface lives inside a WSL distro. */
  linuxConfigDir: string | null
  envPatch: ClaudeEnvPatch
}

export class ClaudeRuntimePathResolver {
  getRuntimePaths(): ClaudeRuntimePaths {
    const inheritedConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || null
    const configDir = inheritedConfigDir || join(homedir(), '.claude')
    mkdirSync(configDir, { recursive: true })

    return {
      surfaceKey: HOST_AUTH_SURFACE_KEY,
      configDir,
      credentialsPath: join(configDir, '.credentials.json'),
      configPath: this.resolveConfigPath(configDir, inheritedConfigDir),
      linuxConfigDir: null,
      envPatch: inheritedConfigDir ? { CLAUDE_CONFIG_DIR: configDir } : {}
    }
  }

  private resolveConfigPath(configDir: string, inheritedConfigDir: string | null): string {
    const colocatedConfigPath = join(configDir, '.claude.json')
    if (inheritedConfigDir || existsSync(colocatedConfigPath)) {
      return colocatedConfigPath
    }
    return join(homedir(), '.claude.json')
  }
}

/**
 * Auth surface for a WSL distro's own `~/.claude`, addressed over its UNC twin.
 * Returns null when the distro can't be reached, so callers can degrade instead
 * of blocking a launch.
 *
 * Deliberately does not read `process.env.CLAUDE_CONFIG_DIR` (a Windows-side
 * value) and never probes the distro beyond the cached `getWslHome`.
 */
export function resolveWslProfilePaths(distro: string): ClaudeRuntimePaths | null {
  const uncHome = getWslHome(distro)
  const uncHomeInfo = uncHome ? parseWslUncPath(uncHome) : null
  if (!uncHome || !uncHomeInfo) {
    return null
  }
  const configDir = join(uncHome, '.claude')
  return {
    surfaceKey: wslAuthSurfaceKey(distro),
    configDir,
    credentialsPath: join(configDir, '.credentials.json'),
    // Why: with no CLAUDE_CONFIG_DIR the distro's Claude always reads $HOME/.claude.json — never the
    // colocated copy the hidden usage probe can leave behind under ~/.claude.
    configPath: join(uncHome, '.claude.json'),
    // Why: consumed inside the distro, so it is joined POSIX-style regardless of the host separator.
    linuxConfigDir: `${uncHomeInfo.linuxPath.replace(/\/$/, '')}/.claude`,
    envPatch: {}
  }
}
