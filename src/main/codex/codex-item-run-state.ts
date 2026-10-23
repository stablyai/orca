import { readString } from './codex-item-field-readers'
import type { CodexThreadItem } from './codex-thread-item-identity'

/** Codex reports `inProgress` then a terminal status; a zero exit code is the
 *  only thing that makes a finished command a success. */
export function codexItemRunState(item: CodexThreadItem): 'running' | 'completed' | 'failed' {
  const status = readString(item, 'status')
  if (status === null || status === 'inProgress') {
    return 'running'
  }
  if (status !== 'completed') {
    return 'failed'
  }
  const exitCode = item.exitCode
  return typeof exitCode === 'number' && exitCode !== 0 ? 'failed' : 'completed'
}
