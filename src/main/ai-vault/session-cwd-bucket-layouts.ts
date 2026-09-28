import type { AiVaultAgent } from '../../shared/ai-vault-types'
import { encodeClaudeProjectPaths, isClaudeProjectDirInScope } from './claude-project-dir-encoding'

/** An agent that keeps one directory per cwd, named by a lossy encoding of that cwd. */
export type CwdBucketLayout = {
  agent: Extract<AiVaultAgent, 'claude' | 'pi'>
  encodeScopePrefixes: (scopePath: string) => string[]
  isDirInScope: (dirName: string, prefixes: ReadonlySet<string>) => boolean
}

export const CLAUDE_CWD_BUCKET_LAYOUT: CwdBucketLayout = {
  agent: 'claude',
  encodeScopePrefixes: encodeClaudeProjectPaths,
  isDirInScope: isClaudeProjectDirInScope
}

// Pi names each bucket `--<cwd without leading slash, with / \ : as ->--`;
// the prefix drops the closing `--` so nested cwds (`--a-b-c--`) still match `--a-b`.
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
      // A root scope encodes to the bare `--`, which contains every bucket.
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
