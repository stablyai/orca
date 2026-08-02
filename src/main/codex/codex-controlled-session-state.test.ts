import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexControlledSessionStateStore } from './codex-controlled-session-state'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('CodexControlledSessionStateStore', () => {
  it.each([
    '{',
    JSON.stringify({
      version: 1,
      conversationId: 'conversation-1',
      threadId: 'thread-1',
      accountId: 'account-1',
      launchFingerprint: 'fingerprint-1',
      turns: []
    }),
    JSON.stringify({
      version: 1,
      conversationId: 'conversation-1',
      threadId: 'thread-1',
      accountId: 'account-1',
      launchFingerprint: 'fingerprint-1',
      turns: { wake: { phase: 'finalized' } }
    })
  ])('rejects malformed persisted state without treating the turn as new', (contents) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-state-'))
    roots.push(root)
    const filePath = join(root, 'state.json')
    writeFileSync(filePath, contents)
    const store = new CodexControlledSessionStateStore(filePath, {
      conversationId: 'conversation-1',
      threadId: 'thread-1',
      accountId: 'account-1',
      launchFingerprint: 'fingerprint-1'
    })

    expect(() => store.get('wake')).toThrow('controlled Codex session state is unreadable')
  })
})
