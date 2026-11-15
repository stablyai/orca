import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { claudeTookHookAnswer, readClaudeToolRecord } from './claude-tool-result-close'

let dir: string | null = null
afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true })
  }
  dir = null
})

it("takes an allowed call whose command then failed as Orca's allow, from Claude's own transcript", async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'claude-tool-record-'))
  const transcript = path.join(dir, 'session.jsonl')
  // The lines Claude 2.1.322 wrote for the owner's live case (2026-11-11), trimmed to what is read.
  await writeFile(
    transcript,
    [
      '{"type":"attachment","attachment":{"type":"hook_permission_decision","decision":"allow","toolUseID":"toolu_live","hookEvent":"PermissionRequest"}}',
      '{"type":"attachment","attachment":{"type":"hook_success","hookEvent":"PostToolUseFailure","toolUseID":"toolu_live"}}',
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_live","is_error":true,"content":"Exit code 1\\n(eval):14: parse error near `\\\\n\'"}]}}'
    ].join('\n')
  )

  const record = await readClaudeToolRecord(transcript, 'toolu_live')
  expect(record).toEqual({
    hookDecision: 'allow',
    result: { isError: true, text: "Exit code 1\n(eval):14: parse error near `\\n'" }
  })
  expect(claudeTookHookAnswer(record!, 'allow', 'use a script file')).toBe(true)
  expect(claudeTookHookAnswer(record!, 'deny', 'use a script file')).toBe(false)
  expect(await readClaudeToolRecord(transcript, 'toolu_other')).toBeNull()
})
