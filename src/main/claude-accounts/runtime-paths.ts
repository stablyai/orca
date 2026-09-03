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
  // Why: resolving paths must stay side-effect free; background usage refresh reads these even
  // when Claude is disabled, and creating the dir here materializes ~/.claude unprompted (STA-3244).
  // Every writer (writeRuntimeCredentials, writeJson) already mkdirs its own parent.
  getRuntimePaths(): ClaudeRuntimePaths {
    const inheritedConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || null
    const configDir = inheritedConfigDir || join(homedir(), '.claude')

    return {
      configDir,
      credentialsPath: join(configDir, '.credentials.json'),
      configPath: this.resolveConfigPath(configDir, inheritedConfigDir),
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
