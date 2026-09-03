import { existsSync, mkdirSync } from 'node:fs'
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
    const configDir = inheritedConfigDir || join(homedir(), '.claude')
    mkdirSync(configDir, { recursive: true })

    return {
      configDir,
      credentialsPath: join(configDir, '.credentials.json'),
      configPath: this.resolveConfigPath(configDir, inheritedConfigDir),
      // Keep an inherited user override visible without forcing the system
      // default into every pane; managed-account branches provide their own
      // isolation patch.
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
