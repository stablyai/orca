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

  // An absolute path means the same file wherever it is asked from.
  const edit = { file_path: '/repo/a/output.json', old_string: 'a', new_string: 'b' }
  expect(ask('Edit', edit, 'call-2')).toBe(ask('Edit', edit, 'call-1'))
})
