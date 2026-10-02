import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listGrokSubagentSessions } from './session-scanner-grok-subagents'

let root: string
let parent: string
const startedAt = '2026-09-07T01:00:00.000Z'

function update(id: string, update: Record<string, unknown>, timestamp = startedAt): unknown {
  return {
    timestamp: Date.parse(timestamp) / 1000,
    method: 'session/update',
    params: { sessionId: id, update }
  }
}

async function json(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}

async function history(path: string, content: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content.map((item) => JSON.stringify(item)).join('\n'))
}

async function child(
  id: string,
  meta: Record<string, unknown> = {},
  group = encodeURIComponent('/repo')
): Promise<string> {
  await json(join(dirname(parent), 'subagents', id, 'meta.json'), {
    subagent_id: id,
    parent_session_id: 'parent',
    child_session_id: id,
    subagent_type: 'explore',
    description: `Task ${id}`,
    status: 'running',
    child_cwd: '/repo',
    effective_model_id: 'grok-code',
    started_at: startedAt,
    ...meta
  })
  const path = join(root, 'sessions', group, id, 'updates.jsonl')
  await json(join(dirname(path), 'summary.json'), {
    info: { id, cwd: '/repo' },
    session_kind: 'subagent'
  })
  await history(path, [
    update(id, {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Sleep 10' }
    }),
    update(id, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Thinking' }
    }),
    update(id, {
      sessionUpdate: 'tool_call',
      toolCallId: 'shell',
      title: 'Sleep',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'sleep 10' }
    }),
    update(id, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'shell',
      status: 'completed',
      rawOutput: 'Done'
    }),
    update(
      id,
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } },
      '2026-09-07T01:00:10.000Z'
    )
  ])
  return path
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-grok-subagents-'))
  parent = join(root, 'sessions', encodeURIComponent('/repo'), 'parent', 'chat_history.jsonl')
  await history(parent, [{ type: 'user', content: 'Start a child' }])
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('listGrokSubagentSessions', () => {
  it('uses presentation updates without stale fork-prefix guesses after compaction or resume', async () => {
    const path = await child('child', { effective_model_id: undefined })
    await json(join(dirname(path), 'summary.json'), {
      info: { id: 'child', cwd: '/repo' },
      parent_session_id: 'parent',
      session_kind: 'subagent_fork',
      inherited_prefix_len: 300,
      current_model_id: 'persisted-model'
    })
    await history(join(dirname(path), 'chat_history.jsonl'), [
      { type: 'assistant', content: 'Inherited parent context' }
    ])
    const fork = (await listGrokSubagentSessions({ parentFilePath: parent })).sessions[0]
    expect(fork.messageCount).toBe(2)
    expect(fork.previewMessages.map((message) => message.text)).toEqual(['Sleep 10', 'Done'])
    expect(fork.model).toBe('persisted-model')
    await json(join(dirname(path), 'summary.json'), {
      info: { id: 'child' },
      parent_session_id: 'previous-child',
      session_kind: 'subagent_resume',
      inherited_prefix_len: 3
    })
    expect(
      (await listGrokSubagentSessions({ parentFilePath: parent })).sessions[0].messageCount
    ).toBe(2)
  })

  it('uses parent metadata and counts visible conversation, not thought/tool rows', async () => {
    const path = await child('child', {
      status: 'completed',
      completed_at: '2026-09-07T01:00:11.000Z'
    })
    const result = await listGrokSubagentSessions({ parentFilePath: parent })
    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      agent: 'grok',
      sessionId: 'child',
      filePath: path,
      cwd: '/repo',
      title: 'Task child',
      model: 'grok-code',
      messageCount: 2,
      createdAt: startedAt,
      updatedAt: '2026-09-07T01:00:11.000Z',
      subagent: {
        parentSessionId: 'parent',
        agentType: 'explore',
        status: 'completed',
        turnStartedAts: [Date.parse(startedAt)]
      }
    })
    expect(result.sessions[0].previewMessages.map((message) => message.text)).toEqual([
      'Sleep 10',
      'Done'
    ])
  })

  it.each([
    ['running', 'running'],
    ['failed', 'failed'],
    ['cancelled', 'stopped'],
    ['unknown', null]
  ])(
    'preserves metadata status %s without inferring completion from an assistant message',
    async (status, expected) => {
      await child('child', { status })
      const result = await listGrokSubagentSessions({ parentFilePath: parent })
      expect(result.sessions[0].subagent?.status).toBe(expected)
    }
  )

  it('finds slug-layout children only in the parent account and lists nested direct children', async () => {
    const childPath = await child('child', {}, 'repo-hash')
    await json(join(dirname(childPath), 'subagents', 'nested', 'meta.json'), {
      subagent_id: 'nested',
      parent_session_id: 'child',
      child_session_id: 'nested',
      status: 'running'
    })
    await history(join(root, 'sessions', 'repo-hash', 'nested', 'updates.jsonl'), [
      update('nested', {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Nested task' }
      })
    ])
    await json(join(root, 'sessions', 'repo-hash', 'nested', 'summary.json'), {
      info: { id: 'nested' }
    })
    expect(
      (await listGrokSubagentSessions({ parentFilePath: parent })).sessions.map(
        (session) => session.sessionId
      )
    ).toEqual(['child'])
    expect(
      (await listGrokSubagentSessions({ parentFilePath: childPath })).sessions.map(
        (session) => session.sessionId
      )
    ).toEqual(['nested'])
  })

  it('rejects wrong-parent metadata, traversal ids, oversized metadata and unknown transcripts', async () => {
    await child('wrong-parent', { parent_session_id: 'other' })
    await child('traversal', { child_session_id: '../escape' })
    await child('oversized', { prompt: 'x'.repeat(65536) })
    await child('unknown', { child_session_id: 'missing' })
    expect((await listGrokSubagentSessions({ parentFilePath: parent })).sessions).toEqual([])
  })

  it('never falls back to inherited chat history when the child updates log is absent', async () => {
    const path = await child('child')
    await rm(path)
    await history(join(dirname(path), 'chat_history.jsonl'), [
      { type: 'assistant', content: 'Parent history must stay private' }
    ])
    expect((await listGrokSubagentSessions({ parentFilePath: parent })).sessions).toEqual([])
  })

  it('counts image-only messages and ignores updates belonging to another nested child', async () => {
    const path = await child('child')
    await history(path, [
      update('child', {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }
      }),
      update('nested-child', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Private nested answer' }
      })
    ])
    const result = (await listGrokSubagentSessions({ parentFilePath: parent })).sessions[0]
    expect(result.messageCount).toBe(1)
    expect(result.previewMessages).toEqual([])
  })

  it('reads isolated updates even when summary is missing, corrupt, or has stale fork metadata', async () => {
    const path = await child('child')
    const summaryPath = join(dirname(path), 'summary.json')
    await rm(summaryPath)
    expect(
      (await listGrokSubagentSessions({ parentFilePath: parent })).sessions[0].messageCount
    ).toBe(2)
    await writeFile(summaryPath, '{invalid')
    expect(
      (await listGrokSubagentSessions({ parentFilePath: parent })).sessions[0].messageCount
    ).toBe(2)
    await json(summaryPath, { info: { id: 'different' } })
    expect(
      (await listGrokSubagentSessions({ parentFilePath: parent })).sessions[0].messageCount
    ).toBe(2)
    await json(summaryPath, {
      info: { id: 'child' },
      session_kind: 'subagent_fork',
      parent_session_id: 'parent',
      inherited_prefix_len: -1
    })
    expect(
      (await listGrokSubagentSessions({ parentFilePath: parent })).sessions[0].messageCount
    ).toBe(2)
  })

  it('does not follow child, metadata or parent-directory symlinks outside the account', async () => {
    const childPath = await child('child')
    await rm(childPath)
    await history(join(root, 'secret.jsonl'), [{ type: 'assistant', content: 'Secret' }])
    await symlink(join(root, 'secret.jsonl'), childPath)
    expect((await listGrokSubagentSessions({ parentFilePath: parent })).sessions).toEqual([])
    await rm(join(dirname(parent), 'subagents'), { recursive: true })
    await mkdir(join(root, 'external'), { recursive: true })
    await symlink(join(root, 'external'), join(dirname(parent), 'subagents'), 'dir')
    expect((await listGrokSubagentSessions({ parentFilePath: parent })).sessions).toEqual([])
  })

  it('does not discover unrelated sessions or leak other account roots', async () => {
    await child('child', { child_session_id: 'other-account' })
    await history(
      join(root, 'other-account', 'sessions', 'repo', 'other-account', 'updates.jsonl'),
      [{ type: 'assistant', content: 'Secret' }]
    )
    await history(join(root, 'sessions', 'repo', 'unrelated', 'updates.jsonl'), [
      { type: 'assistant', content: 'Unrelated' }
    ])
    expect((await listGrokSubagentSessions({ parentFilePath: parent })).sessions).toEqual([])
  })

  it('returns an empty list when no subagents exist or the parent is not a Grok transcript', async () => {
    expect(await listGrokSubagentSessions({ parentFilePath: parent })).toEqual({
      sessions: [],
      issues: []
    })
    expect(await listGrokSubagentSessions({ parentFilePath: join(root, 'unknown.jsonl') })).toEqual(
      { sessions: [], issues: [] }
    )
  })
})
