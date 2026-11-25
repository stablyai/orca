import { existsSync } from 'node:fs'
import {
  defaultAgentHomeDir,
  defaultClaudeJsonPath
} from '../../../shared/app-profiles/app-profile-homes'
import { join } from 'node:path'
import type { ClaudeEnvPatch } from './environment'

export type ClaudeRuntimePaths = {
  configDir: string
  configPath: string
  envPatch: ClaudeEnvPatch
}

export class ClaudeRuntimePathResolver {
  getRuntimePaths(): ClaudeRuntimePaths {
    const inheritedConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || null
    // Resolve without creating directories: usage polling runs even when Claude is disabled.
    const configDir = inheritedConfigDir || defaultAgentHomeDir('CLAUDE_CONFIG_DIR', '.claude')

    return {
      configDir,
      configPath: this.resolveConfigPath(configDir, inheritedConfigDir),
      envPatch: inheritedConfigDir ? { CLAUDE_CONFIG_DIR: configDir } : {}
    }
  }

  private resolveConfigPath(configDir: string, inheritedConfigDir: string | null): string {
    const colocatedConfigPath = join(configDir, '.claude.json')
    if (inheritedConfigDir || existsSync(colocatedConfigPath)) {
      return colocatedConfigPath
    }
    return defaultClaudeJsonPath()
  }
}
