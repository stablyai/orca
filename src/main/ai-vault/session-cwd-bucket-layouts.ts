import { join } from 'node:path'
import type { AiVaultAgent } from '../../shared/ai-vault/contracts/ai-vault-types'
import {
  encodeClaudeProjectPaths,
  isClaudeProjectDirInScope
} from './scanners/claude/claude-project-dir-encoding'

export type CwdBucketLayout = {
  agent: Extract<AiVaultAgent, 'claude' | 'pi' | 'codebuddy'>
  encodeScopePrefixes: (scopePath: string) => string[]
  isDirInScope: (dirName: string, prefixes: ReadonlySet<string>) => boolean
  /** Folders whose children are cwd buckets; defaults to the root itself. */
  bucketDirs?: (rootDir: string) => string[]
}

// Claude Code names a longer encoded path's bucket `<first 200 characters>-<hash>`.
const CLAUDE_BUCKET_NAME_MAX_LENGTH = 200

export const CLAUDE_CWD_BUCKET_LAYOUT: CwdBucketLayout = {
  agent: 'claude',
  encodeScopePrefixes: (scopePath) =>
    encodeClaudeProjectPaths(scopePath).map((encoded) =>
      encoded.slice(0, CLAUDE_BUCKET_NAME_MAX_LENGTH)
    ),
  // A root (`-`, `c--`) already ends at a separator, so every bucket below it starts with it.
  isDirInScope: (dirName, prefixes) => {
    if (isClaudeProjectDirInScope(dirName, prefixes)) {
      return true
    }
    for (const prefix of prefixes) {
      if (prefix.endsWith('-') && dirName.startsWith(prefix)) {
        return true
      }
    }
    return false
  }
}

// Omit Pi's closing -- so the prefix also matches nested working directories.
function encodePiSessionDirPrefix(pathValue: string): string {
  const trimmed = pathValue.length > 1 ? pathValue.replace(/[/\\]+$/, '') : pathValue
  return `--${trimmed.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}`
}

export const PI_CWD_BUCKET_LAYOUT: CwdBucketLayout = {
  agent: 'pi',
  // PI_CODING_AGENT_DIR=<dir> makes Pi's root the agent folder, whose buckets sit under sessions/.
  bucketDirs: (rootDir) => [rootDir, join(rootDir, 'sessions')],
  encodeScopePrefixes: (pathValue) => {
    const raw = encodePiSessionDirPrefix(pathValue)
    const composed = encodePiSessionDirPrefix(pathValue.normalize('NFC'))
    return raw === composed ? [raw] : [raw, composed]
  },
  isDirInScope: (dirName, prefixes) => {
    for (const prefix of prefixes) {
      // Root scope encodes to -- and includes every Pi bucket.
      if (prefix === '--' && dirName.startsWith('--') && dirName.endsWith('--')) {
        return true
      }
      if (dirName === `${prefix}--` || dirName.startsWith(`${prefix}-`)) {
        return true
      }
    }
    return false
  }
}

// CodeBuddy 2.159.0 collapses separators and retains 180 UTF-8 bytes before long-path hashes.
function codebuddyScopePrefix(path: string): string {
  const encoded = path
    .replace(/[/\\:]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  let prefix = ''
  for (const character of encoded) {
    if (Buffer.byteLength(prefix + character, 'utf8') > 180) {
      break
    }
    prefix += character
  }
  return prefix
}

export const CODEBUDDY_CWD_BUCKET_LAYOUT: CwdBucketLayout = {
  agent: 'codebuddy',
  encodeScopePrefixes: (path) => [
    ...new Set([path, path.normalize('NFC')].map(codebuddyScopePrefix))
  ],
  // Lossy bucket names only prefilter; the transcript cwd decides membership.
  isDirInScope: (name, prefixes) => [...prefixes].some((prefix) => name.startsWith(prefix))
}
