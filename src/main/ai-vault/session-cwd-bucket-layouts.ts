import type { AiVaultAgent } from '../../shared/ai-vault-types'
import { encodeClaudeProjectPaths, isClaudeProjectDirInScope } from './claude-project-dir-encoding'

export type CwdBucketLayout = {
  agent: Extract<AiVaultAgent, 'claude' | 'pi' | 'codebuddy'>
  encodeScopePrefixes: (scopePath: string) => string[]
  isDirInScope: (dirName: string, prefixes: ReadonlySet<string>) => boolean
}

export const CLAUDE_CWD_BUCKET_LAYOUT: CwdBucketLayout = {
  agent: 'claude',
  encodeScopePrefixes: encodeClaudeProjectPaths,
  isDirInScope: isClaudeProjectDirInScope
}

// Omit Pi's closing -- so the prefix also matches nested working directories.
function encodePiSessionDirPrefix(pathValue: string): string {
  const trimmed = pathValue.length > 1 ? pathValue.replace(/[/\\]+$/, '') : pathValue
  return `--${trimmed.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}`
}

export const PI_CWD_BUCKET_LAYOUT: CwdBucketLayout = {
  agent: 'pi',
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
