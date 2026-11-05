import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const CONFIG_FILE_LIMIT = 1024 * 1024

export function directoriesUpToRoot(cwd: string): string[] {
  const directories = [cwd]
  while (directories.at(-1) !== dirname(directories.at(-1)!)) {
    directories.push(dirname(directories.at(-1)!))
  }
  return directories
}

// Absent files read as null; oversized or unreadable files throw so callers fail closed.
export async function readOptionalConfigFile(file: string): Promise<string | null> {
  try {
    const content = await readFile(file, 'utf8')
    if (content.length > CONFIG_FILE_LIMIT) {
      throw new Error('Configuration file is too large')
    }
    return content
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null
    }
    throw error
  }
}

export const forbiddenClaudeEnvironment =
  /^(ANTHROPIC_|CLAUDE_CODE_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NODE_OPTIONS$)/i

function managedSettingsPath() {
  return process.platform === 'darwin'
    ? '/Library/Application Support/ClaudeCode/managed-settings.json'
    : process.platform === 'win32'
      ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json')
      : '/etc/claude-code/managed-settings.json'
}

/** Fingerprint of the Claude config that shapes a run, or null when managed or unsupported policy applies. */
export async function claudeTextConfiguration(home: string, cwd: string): Promise<string | null> {
  const files = [join(home, 'settings.json'), join(home, 'CLAUDE.md')]
  for (const directory of directoriesUpToRoot(cwd)) {
    files.push(
      join(directory, '.claude', 'settings.json'),
      join(directory, '.claude', 'settings.local.json'),
      join(directory, 'CLAUDE.md')
    )
  }
  try {
    // Managed policy cannot be overridden by a helper; unsupported policies keep ordinary execution.
    const [contents, managed] = await Promise.all([
      Promise.all(files.map(readOptionalConfigFile)),
      stat(managedSettingsPath()).then(
        () => true,
        () => false
      )
    ])
    if (managed) {
      return null
    }
    for (const [index, content] of contents.entries()) {
      if (content && files[index].endsWith('.json')) {
        const value = JSON.parse(content)
        if (
          value.apiKeyHelper ||
          value.forceLoginMethod ||
          value.forceLoginOrgUUID ||
          Object.keys(value.env ?? {}).some(
            (key) =>
              forbiddenClaudeEnvironment.test(key) || /CLAUDE_CONFIG_DIR|ORCA_CLAUDE/i.test(key)
          )
        ) {
          return null
        }
      }
    }
    return JSON.stringify(contents)
  } catch {
    return null
  }
}
