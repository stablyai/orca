import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { projectConversations } from '../../shared/project-conversation-list'
import { scanAiVaultSessions } from './session-scanner'
import { MAX_SESSION_TRANSCRIPT_RECORD_BYTES } from './session-transcript-record-budget'
import { isolatedScanRoots, writeJsonlFile } from './session-scanner-test-fixtures'

const roots: string[] = []
const caveat = '<local-command-caveat>Local command output follows</local-command-caveat>'
const preferences = { revision: 0, entries: {} }

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function history() {
  const root = await mkdtemp(join(tmpdir(), 'orca-native-claude-content-'))
  roots.push(root)
  const options = { ...isolatedScanRoots(root), claudeProfileProjectsDirs: [] }
  return {
    options,
    file: (id: string) => join(options.claudeProjectsDir, 'project', `${id}.jsonl`)
  }
}

function user(sessionId: string, content: unknown) {
  return {
    type: 'user',
    sessionId,
    cwd: '/notes',
    timestamp: '2026-10-01T10:00:00.000Z',
    message: { role: 'user', content }
  }
}

describe('native Claude conversation content evidence', () => {
  it('keeps command transcripts readable without creating a placeholder Projects chat', async () => {
    const { options, file } = await history()
    await writeJsonlFile(file('command-only'), [
      { type: 'mode', sessionId: 'command-only', mode: 'default' },
      { type: 'permission-mode', sessionId: 'command-only', permissionMode: 'default' },
      user('command-only', caveat),
      user('command-only', '<command-name>/exit</command-name>'),
      user('command-only', '<local-command-stdout>See you</local-command-stdout>')
    ])

    const result = await scanAiVaultSessions(options)

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      title: 'Claude command-',
      conversationContent: 'empty',
      messageCount: 3,
      previewMessages: expect.arrayContaining([expect.objectContaining({ text: caveat })])
    })
    expect(projectConversations(result.sessions, preferences)).toEqual([])

    await appendFile(
      file('command-only'),
      `${JSON.stringify(user('command-only', 'Repair the reader'))}\n`
    )
    const updated = await scanAiVaultSessions(options)
    expect(updated.sessions[0]).toMatchObject({
      id: result.sessions[0]?.id,
      title: 'Repair the reader',
      conversationContent: 'present',
      messageCount: 4
    })
    expect(projectConversations(updated.sessions, preferences)).toHaveLength(1)
  })

  it('retains queued, non-text, unknown and corrupt provider history', async () => {
    const { options, file } = await history()
    await writeJsonlFile(file('queued'), [
      { type: 'queue-operation', operation: 'enqueue', sessionId: 'queued', content: 'Recover me' }
    ])
    await writeJsonlFile(file('non-text'), [
      user('non-text', [{ type: 'image', source: { type: 'base64', data: 'aGVsbG8=' } }])
    ])
    await writeJsonlFile(file('tool-result'), [
      user('tool-result', [{ type: 'tool_result', content: 'Tool output cannot name a chat' }])
    ])
    await writeJsonlFile(file('unknown'), [
      { type: 'future-provider-record', sessionId: 'unknown' }
    ])
    await writeJsonlFile(file('corrupt'), [user('corrupt', caveat)])
    await appendFile(file('corrupt'), '{incomplete provider record\n')

    const result = await scanAiVaultSessions(options)
    const content = new Map(
      result.sessions.map((session) => [session.sessionId, session.conversationContent])
    )

    expect(result.issues).toEqual([])
    expect(content.get('queued')).toBe('present')
    expect(content.get('non-text')).toBe('present')
    expect(result.sessions.find((session) => session.sessionId === 'tool-result')?.title).toBe(
      'Claude tool-res'
    )
    expect(content.get('unknown')).toBe('unknown')
    expect(content.get('corrupt')).toBe('unknown')
    expect(projectConversations(result.sessions, preferences)).toHaveLength(5)
  })

  it('never calls a transcript empty when bounded reads skipped possible history', async () => {
    const { options, file } = await history()
    await writeJsonlFile(file('oversized'), [user('oversized', caveat)])
    await appendFile(file('oversized'), `${'x'.repeat(MAX_SESSION_TRANSCRIPT_RECORD_BYTES + 1)}\n`)

    const result = await scanAiVaultSessions(options)

    expect(result.issues).toEqual([expect.objectContaining({ kind: 'notice' })])
    expect(result.sessions[0]?.conversationContent).toBe('unknown')
    expect(projectConversations(result.sessions, preferences)).toHaveLength(1)
    await appendFile(file('oversized'), `${JSON.stringify(user('oversized', caveat))}\n`)
    const updated = await scanAiVaultSessions(options)
    expect(updated.sessions[0]?.conversationContent).toBe('unknown')
  })

  it('recovers late child transcripts even when cached command records count as turns', async () => {
    const { options, file } = await history()
    await writeJsonlFile(file('late-child'), [user('late-child', caveat)])
    const first = await scanAiVaultSessions(options)
    expect(first.sessions[0]?.conversationContent).toBe('empty')

    await writeJsonlFile(
      join(options.claudeProjectsDir, 'project', 'late-child', 'subagents', 'agent-late.jsonl'),
      [user('child', 'Recover this work')]
    )
    const second = await scanAiVaultSessions(options)

    expect(second.sessions[0]).toMatchObject({
      id: first.sessions[0]?.id,
      messageCount: 1,
      subagentTranscriptCount: 1,
      conversationContent: 'present'
    })
    expect(projectConversations(second.sessions, preferences)).toHaveLength(1)
  })
})
