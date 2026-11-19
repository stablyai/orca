import { expect, it } from 'vitest'
import { claudeApprovalItem } from './claude-structured-prompt-items'
import type { ClaudePendingPrompt } from '../permissions/claude-prompt-registry'

const ask = (toolName: string, input: Record<string, unknown>, toolUseId: string) =>
  claudeApprovalItem({
    requestId: `request-${toolUseId}`,
    promptKey: `key-${toolUseId}`,
    toolUseId,
    toolName,
    kind: 'approval',
    input,
    suggestions: [],
    questionIds: [],
    settle: () => {}
  } satisfies ClaudePendingPrompt).requestDigest

it('never lets a resumed shell command take an answer given in another directory', () => {
  // Same command, asked before and after a restart: Claude can't say which directory either ran in.
  const remove = { command: 'rm ./output.json' }
  expect(ask('Bash', remove, 'call-1')).toBeDefined()
  expect(ask('Bash', remove, 'call-2')).not.toBe(ask('Bash', remove, 'call-1'))

  // A path naming its root means the same file wherever it is asked from; on Windows that takes a drive.
  const root = process.platform === 'win32' ? 'C:\\repo' : '/repo'
  const edit = { file_path: `${root}/output.json`, old_string: 'a', new_string: 'b' }
  expect(ask('Edit', edit, 'call-2')).toBe(ask('Edit', edit, 'call-1'))
  const relative = { file_path: 'output.json', old_string: 'a', new_string: 'b' }
  expect(ask('Edit', relative, 'call-2')).not.toBe(ask('Edit', relative, 'call-1'))
  if (process.platform === 'win32') {
    const driveless = { file_path: '\\repo\\output.json', old_string: 'a', new_string: 'b' }
    expect(ask('Edit', driveless, 'call-2')).not.toBe(ask('Edit', driveless, 'call-1'))
  }

  // A search with no path searches wherever the session is; any tool Orca can't vouch for asks live.
  const search = { pattern: 'secret' }
  expect(ask('Grep', search, 'call-2')).not.toBe(ask('Grep', search, 'call-1'))
  const rooted = { pattern: 'secret', path: root }
  expect(ask('Grep', rooted, 'call-2')).toBe(ask('Grep', rooted, 'call-1'))
  expect(ask('mcp__db__query', { sql: 'select 1' }, 'call-2')).not.toBe(
    ask('mcp__db__query', { sql: 'select 1' }, 'call-1')
  )
})
