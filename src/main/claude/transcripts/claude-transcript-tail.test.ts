import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readClaudeTranscriptTail } from './claude-transcript-tail'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

const row = (uuid: string, parentUuid: string | null, type: string, messageId?: string) => ({
  type,
  uuid,
  parentUuid,
  sessionId: 's',
  message: { ...(messageId ? { id: messageId } : {}), role: type, content: [] }
})

async function transcript(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-claude-tail-'))
  roots.push(root)
  const path = join(root, 's.jsonl')
  const rows = [
    row('prompt', null, 'user'),
    row('block-0', 'prompt', 'assistant', 'msg_1'),
    row('block-1', 'block-0', 'assistant', 'msg_1'),
    row('result', 'block-1', 'user')
  ]
  await writeFile(path, `${rows.map((each) => JSON.stringify(each)).join('\n')}\n`)
  return path
}

// A streamed block saved mid-message may hold only its start: its whole message is read again, so
// the finished text replaces the partial one instead of being skipped as already saved.
it('reads a possibly partial saved message again, from its first row', async () => {
  const filePath = await transcript()
  const tail = await readClaudeTranscriptTail({
    filePath,
    leafUuid: '',
    throughMessage: 'msg_1',
    check: () => {}
  })
  expect(tail?.rows.map((each) => each.uuid)).toEqual(['block-0', 'block-1', 'result'])
  const afterRow = await readClaudeTranscriptTail({
    filePath,
    leafUuid: 'block-0',
    check: () => {}
  })
  expect(afterRow?.rows.map((each) => each.uuid)).toEqual(['block-1', 'result'])
})
