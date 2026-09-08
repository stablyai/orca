import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  seedEmulatorAgentHistoryFixture,
  EMULATOR_AGENT_HISTORY_PREVIEW_MARKER
} from './emulator-agent-history-fixture.mjs'
import {
  appendHostedChatFeedMarker,
  assertHostedChatInputReceipt,
  consumeHostedChatPtyInput
} from './hosted-chat-transcript-fixture.mjs'

test('appends a real Codex feed record without replacing seeded history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orca-chat-fixture-'))
  try {
    const transcriptPath = seedEmulatorAgentHistoryFixture({ homeDir: root, workspacePath: root })
    const marker = await appendHostedChatFeedMarker(transcriptPath)
    const records = (await readFile(transcriptPath, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(records.length, 4)
    assert.equal(records[2].payload.content[0].text, EMULATOR_AGENT_HISTORY_PREVIEW_MARKER)
    assert.equal(records[3].payload.content[0].text, marker)
    assert.equal(records[3].payload.role, 'assistant')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('refuses duplicate or unsubmitted PTY receipts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orca-chat-receipt-'))
  const receipt = path.join(root, 'input.jsonl')
  try {
    const line = JSON.stringify({ text: 'probe', submitted: true })
    await writeFile(receipt, `${line}\n`)
    assert.deepEqual(await assertHostedChatInputReceipt(receipt, 'probe'), {
      submittedExactlyOnce: true
    })
    await writeFile(receipt, `${line}\n${line}\n`)
    await assert.rejects(assertHostedChatInputReceipt(receipt, 'probe'), /exactly once/)
    await writeFile(receipt, JSON.stringify({ text: 'probe', submitted: false }))
    await assert.rejects(assertHostedChatInputReceipt(receipt, 'probe'), /exactly once/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('interprets prompt clear and bracketed paste across PTY chunks before submit', () => {
  let input = consumeHostedChatPtyInput('', 'discarded prompt')
  assert.deepEqual(input.submitted, [])
  input = consumeHostedChatPtyInput(input.pending, '\u0015\u001b[200~sent ')
  assert.deepEqual(input.submitted, [])
  input = consumeHostedChatPtyInput(input.pending, 'message\u001b[201~\r\n')
  assert.deepEqual(input, { pending: '', submitted: ['sent message'] })
  assert.deepEqual(consumeHostedChatPtyInput('', 'one\rtwo\r').submitted, ['one', 'two'])
})
