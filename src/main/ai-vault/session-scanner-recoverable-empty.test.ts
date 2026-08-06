import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isAiVaultSessionRecoverableEmpty } from '../../shared/ai-vault-types'
import { scanAiVaultSessions } from './session-scanner'
import { parseClaudeSessionContent } from './session-scanner-primary-parsers'
import { countSubagentTranscripts } from './session-scanner-subagent-transcripts'
import { isolatedScanRoots, writeJsonlFile } from './session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

// Shape of the real ~/.claude/.../9176163a-*.jsonl artifact: CLI metadata plus
// four queued subagent messages, and zero user/assistant conversation turns.
function metadataOnlyTranscript(sessionId: string): unknown[] {
  return [
    {
      type: 'last-prompt',
      lastPrompt: 'Run the review',
      leafUuid: 'leaf-1',
      sessionId
    },
    { type: 'ai-title', aiTitle: 'Push failure recovery review', sessionId },
    { type: 'mode', mode: 'default', sessionId },
    { type: 'permission-mode', permissionMode: 'acceptEdits', sessionId },
    ...['contracts', 'environment', 'correctness', 'perf'].map((lens, index) => ({
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: `2026-07-08T16:3${index}:00.000Z`,
      sessionId,
      content: `<agent-message from="rev-${lens}">Review complete</agent-message>`
    }))
  ]
}

describe('recoverable-but-empty Claude sessions', () => {
  it('surfaces a zero-turn session with queued messages and subagent transcripts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-recoverable-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const sessionId = '9176163a-2f89-431f-b202-32f04d61f124'

    await writeJsonlFile(
      join(roots.claudeProjectsDir, 'project', `${sessionId}.jsonl`),
      metadataOnlyTranscript(sessionId)
    )
    // Sibling subagent transcripts survive even though the parent conversation
    // was never persisted; a .meta.json sidecar is not a transcript.
    const subagentsDir = join(roots.claudeProjectsDir, 'project', sessionId, 'subagents')
    await writeJsonlFile(join(subagentsDir, 'agent-arev-contracts-1.jsonl'), [
      {
        type: 'user',
        sessionId,
        message: { role: 'user', content: 'Contracts review' }
      }
    ])
    await writeJsonlFile(join(subagentsDir, 'agent-arev-perf-2.jsonl'), [
      {
        type: 'user',
        sessionId,
        message: { role: 'user', content: 'Perf review' }
      }
    ])
    await writeFile(join(subagentsDir, 'agent-arev-contracts-1.meta.json'), '{}')

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })
    const session = result.sessions.find((entry) => entry.sessionId === sessionId)

    expect(session).toBeDefined()
    expect(session?.messageCount).toBe(0)
    expect(session?.queuedMessageCount).toBe(4)
    expect(session?.subagentTranscriptCount).toBe(2)
    expect(isAiVaultSessionRecoverableEmpty(session!)).toBe(true)
  })

  it('reports no recoverable signal for a plain metadata-only session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-plain-empty-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const sessionId = 'plain-empty-session'

    await writeJsonlFile(join(roots.claudeProjectsDir, 'project', `${sessionId}.jsonl`), [
      { type: 'mode', mode: 'default', sessionId },
      { type: 'permission-mode', permissionMode: 'default', sessionId }
    ])

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })
    const session = result.sessions.find((entry) => entry.sessionId === sessionId)

    expect(session).toBeDefined()
    expect(session?.messageCount).toBe(0)
    expect(session?.queuedMessageCount).toBe(0)
    expect(session?.subagentTranscriptCount).toBe(0)
    expect(isAiVaultSessionRecoverableEmpty(session!)).toBe(false)
  })

  it('counts subagent transcripts for a session that has real turns without flagging it recoverable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-nonempty-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const sessionId = 'conversation-session'

    await writeJsonlFile(join(roots.claudeProjectsDir, 'project', `${sessionId}.jsonl`), [
      {
        type: 'user',
        sessionId,
        message: { role: 'user', content: 'Do the thing' }
      }
    ])
    await writeJsonlFile(
      join(roots.claudeProjectsDir, 'project', sessionId, 'subagents', 'agent-x.jsonl'),
      [
        {
          type: 'user',
          sessionId,
          message: { role: 'user', content: 'Subtask' }
        }
      ]
    )

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })
    const session = result.sessions.find((entry) => entry.sessionId === sessionId)

    expect(session?.messageCount).toBe(1)
    // Counted for every local session (the row's "N subagents" affordance),
    // but a session with real turns is never surfaced as recoverable-empty.
    expect(session?.subagentTranscriptCount).toBe(1)
    expect(isAiVaultSessionRecoverableEmpty(session!)).toBe(false)
  })

  it('counts queued messages net of remove and dequeue operations', async () => {
    const sessionId = 'net-queue-session'
    const content = [
      { type: 'mode', mode: 'default', sessionId },
      ...[1, 2, 3].map((n) => ({
        type: 'queue-operation',
        operation: 'enqueue',
        sessionId,
        content: `queued prompt ${n}`
      })),
      // One prompt consumed, one removed by the user: only one is still queued.
      { type: 'queue-operation', operation: 'dequeue', sessionId },
      {
        type: 'queue-operation',
        operation: 'remove',
        sessionId,
        content: null
      }
    ]
      .map((line) => JSON.stringify(line))
      .join('\n')
    const file = {
      path: `/tmp/${sessionId}.jsonl`,
      mtimeMs: 0,
      modifiedAt: '2026-07-08T16:30:00.000Z'
    }

    const session = await parseClaudeSessionContent(file, content, 'darwin', {
      executionHostId: 'ssh:host'
    })
    expect(session?.queuedMessageCount).toBe(1)
  })

  it('picks up subagent transcripts written after the parent transcript last changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-late-sub-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const sessionId = 'late-subagent-session'

    await writeJsonlFile(join(roots.claudeProjectsDir, 'project', `${sessionId}.jsonl`), [
      { type: 'mode', mode: 'default', sessionId }
    ])
    const first = await scanAiVaultSessions({ ...roots, platform: 'darwin' })
    expect(
      first.sessions.find((entry) => entry.sessionId === sessionId)?.subagentTranscriptCount
    ).toBe(0)

    // The parent file never changes again, but a still-running subagent lands
    // its transcript afterwards; the cached parse must still surface it.
    await writeJsonlFile(
      join(roots.claudeProjectsDir, 'project', sessionId, 'subagents', 'agent-late.jsonl'),
      [
        {
          type: 'user',
          sessionId,
          message: { role: 'user', content: 'Late subtask' }
        }
      ]
    )
    const second = await scanAiVaultSessions({ ...roots, platform: 'darwin' })
    expect(
      second.sessions.find((entry) => entry.sessionId === sessionId)?.subagentTranscriptCount
    ).toBe(1)
  })

  it('never counts local subagent transcripts for a remote-host transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-remote-'))
    tempRoots.push(root)
    const sessionId = 'remote-session'
    const transcriptPath = join(root, `${sessionId}.jsonl`)
    // A local sibling dir exists, but the transcript content came from an SSH
    // host — its real subagents live on that host, not on this disk.
    await writeJsonlFile(join(root, sessionId, 'subagents', 'agent-x.jsonl'), [{ type: 'user' }])
    const content = metadataOnlyTranscript(sessionId)
      .map((line) => JSON.stringify(line))
      .join('\n')
    const file = {
      path: transcriptPath,
      mtimeMs: 0,
      modifiedAt: '2026-07-08T16:30:00.000Z'
    }

    const remote = await parseClaudeSessionContent(file, content, 'linux', {
      executionHostId: 'ssh:host'
    })
    expect(remote?.subagentTranscriptCount).toBe(0)
    expect(remote?.queuedMessageCount).toBe(4)

    const local = await parseClaudeSessionContent(file, content, 'darwin')
    expect(local?.subagentTranscriptCount).toBe(1)
  })
})

describe('countSubagentTranscripts', () => {
  it('returns 0 when the sibling subagents directory is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-nosub-'))
    tempRoots.push(root)
    expect(await countSubagentTranscripts(join(root, 'session.jsonl'))).toBe(0)
  })

  it('counts only .jsonl transcripts, excluding meta sidecars', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-sub-count-'))
    tempRoots.push(root)
    const transcriptPath = join(root, 'session.jsonl')
    const subagentsDir = join(root, 'session', 'subagents')
    await writeJsonlFile(join(subagentsDir, 'agent-a.jsonl'), [{ type: 'user' }])
    await writeJsonlFile(join(subagentsDir, 'agent-b.jsonl'), [{ type: 'user' }])
    await writeFile(join(subagentsDir, 'agent-a.meta.json'), '{}')

    expect(await countSubagentTranscripts(transcriptPath)).toBe(2)
  })

  it('excludes non-agent .jsonl files and directories named like transcripts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-sub-predicate-'))
    tempRoots.push(root)
    const transcriptPath = join(root, 'session.jsonl')
    const subagentsDir = join(root, 'session', 'subagents')
    await writeJsonlFile(join(subagentsDir, 'agent-a.jsonl'), [{ type: 'user' }])
    // A stray sibling artifact and a directory would inflate the row badge past
    // what the on-demand lister shows; both must fail the shared predicate.
    await writeFile(join(subagentsDir, 'notes.jsonl'), '{}')
    await mkdir(join(subagentsDir, 'agent-x.jsonl'))

    expect(await countSubagentTranscripts(transcriptPath)).toBe(1)
  })
})
