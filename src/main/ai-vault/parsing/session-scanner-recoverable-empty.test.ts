import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from '../session-scanner'
import { parseClaudeSessionContent } from '../scanners/claude/session-scanner-primary-parsers'
import {
  isolatedScanRoots,
  writeJsonlFile
} from '../scanner-fixtures/session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

// Mirror a real metadata-only Claude transcript containing queued subagent messages but no conversation turns.
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

    // Child writes must refresh recoverability without changing the cached parent transcript.
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
    // Same-path local artifacts must not enrich a transcript fetched from an SSH host.
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
