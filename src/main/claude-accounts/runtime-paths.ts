import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeEnvPatch } from './environment'

export type ClaudeRuntimePaths = {
  configDir: string
  credentialsPath: string
  configPath: string
  envPatch: ClaudeEnvPatch
}

export class ClaudeRuntimePathResolver {
  getRuntimePaths(): ClaudeRuntimePaths {
    const inheritedConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || null
    // Why: disabled Claude still reaches this resolver through background usage refreshes.
    const configDir = inheritedConfigDir || join(homedir(), '.claude')

    return {
      configDir,
      credentialsPath: join(configDir, '.credentials.json'),
      configPath: this.resolveConfigPath(configDir, inheritedConfigDir),
      envPatch: inheritedConfigDir ? { CLAUDE_CONFIG_DIR: configDir } : {}
    }
  }

  private resolveConfigPath(configDir: string, inheritedConfigDir: string | null): string {
    // Why: mirrors Claude's global-config rule: a legacy .config.json in the config directory
    // wins; otherwise the colocated .claude.json is read only when CLAUDE_CONFIG_DIR is set.
    const legacyConfigPath = join(configDir, '.config.json')
    if (existsSync(legacyConfigPath)) {
      return legacyConfigPath
    }
    const colocatedConfigPath = join(configDir, '.claude.json')
    if (inheritedConfigDir) {
      return colocatedConfigPath
    }
    return join(homedir(), '.claude.json')
  }
}
