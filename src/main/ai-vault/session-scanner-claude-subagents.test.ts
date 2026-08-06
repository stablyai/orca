import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listClaudeSubagentSessions } from './session-scanner-claude-subagents'
import { countSubagentTranscripts } from './session-scanner-subagent-transcripts'

let tempRoots: string[] = []

async function writeJsonlFile(filePath: string, records: unknown[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
}

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function writeSubagentTranscript(args: {
  subagentsDir: string
  agentId: string
  taskPrompt: string
  timestamp: string
}): Promise<void> {
  await writeJsonlFile(join(args.subagentsDir, `agent-${args.agentId}.jsonl`), [
    {
      type: 'user',
      sessionId: 'parent-session',
      isSidechain: true,
      agentId: args.agentId,
      timestamp: args.timestamp,
      cwd: '/tmp/claude',
      message: { role: 'user', content: args.taskPrompt }
    }
  ])
}

describe('listClaudeSubagentSessions', () => {
  it('lists subagents titled by the spawn description, newest first, linked to the parent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-subagent-list-'))
    tempRoots.push(root)
    const parentFilePath = join(root, 'project', 'parent-session.jsonl')
    const subagentsDir = join(root, 'project', 'parent-session', 'subagents')

    await writeJsonlFile(parentFilePath, [
      {
        type: 'user',
        sessionId: 'parent-session',
        timestamp: '2026-07-05T10:00:00.000Z',
        cwd: '/tmp/claude',
        message: { role: 'user', content: 'Parent prompt' }
      }
    ])
    await writeSubagentTranscript({
      subagentsDir,
      agentId: 'older',
      taskPrompt: 'Task prompt for the older subagent',
      timestamp: '2026-07-05T10:01:00.000Z'
    })
    await writeFile(
      join(subagentsDir, 'agent-older.meta.json'),
      JSON.stringify({
        agentType: 'Explore',
        description: 'Map the scanner internals',
        toolUseId: 'toolu_older'
      })
    )
    await writeSubagentTranscript({
      subagentsDir,
      agentId: 'newer',
      taskPrompt: 'Task prompt for the newer subagent',
      timestamp: '2026-07-05T10:02:00.000Z'
    })
    await writeFile(
      join(subagentsDir, 'agent-newer.meta.json'),
      JSON.stringify({
        agentType: 'general-purpose',
        description: 'Check latest news',
        toolUseId: 'toolu_newer'
      })
    )

    const result = await listClaudeSubagentSessions({ parentFilePath, platform: 'darwin' })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.title)).toEqual([
      'Check latest news',
      'Map the scanner internals'
    ])
    // No task notifications in the parent and freshly written transcripts:
    // both count as still running.
    expect(result.sessions.map((session) => session.subagent)).toEqual([
      { parentSessionId: 'parent-session', agentType: 'general-purpose', status: 'running' },
      { parentSessionId: 'parent-session', agentType: 'Explore', status: 'running' }
    ])
    expect(result.sessions.map((session) => session.messageCount)).toEqual([1, 1])
  })

  it('falls back to the Task prompt title when the meta sidecar is missing or corrupt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-subagent-meta-'))
    tempRoots.push(root)
    const parentFilePath = join(root, 'project', 'parent-session.jsonl')
    const subagentsDir = join(root, 'project', 'parent-session', 'subagents')

    await writeSubagentTranscript({
      subagentsDir,
      agentId: 'nometa',
      taskPrompt: 'Sidecarless task prompt',
      timestamp: '2026-07-05T10:01:00.000Z'
    })
    await writeSubagentTranscript({
      subagentsDir,
      agentId: 'badmeta',
      taskPrompt: 'Corrupt sidecar task prompt',
      timestamp: '2026-07-05T10:02:00.000Z'
    })
    await writeFile(join(subagentsDir, 'agent-badmeta.meta.json'), '{not json')

    const result = await listClaudeSubagentSessions({ parentFilePath, platform: 'darwin' })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.title)).toEqual([
      'Corrupt sidecar task prompt',
      'Sidecarless task prompt'
    ])
    expect(result.sessions.map((session) => session.subagent?.agentType)).toEqual([null, null])
  })

  it('resolves statuses from parent task notifications, falling back to transcript recency', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-subagent-status-'))
    tempRoots.push(root)
    const parentFilePath = join(root, 'project', 'parent-session.jsonl')
    const subagentsDir = join(root, 'project', 'parent-session', 'subagents')

    await writeJsonlFile(parentFilePath, [
      {
        type: 'user',
        sessionId: 'parent-session',
        timestamp: '2026-07-05T10:00:00.000Z',
        cwd: '/tmp/claude',
        message: { role: 'user', content: 'Parent prompt' }
      },
      {
        // Interim notification: superseded by the terminal one below.
        type: 'user',
        sessionId: 'parent-session',
        timestamp: '2026-07-05T10:00:30.000Z',
        message: {
          role: 'user',
          content:
            '<task-notification>\n<task-id>finished</task-id>\n<status>running</status>\n</task-notification>'
        }
      },
      {
        type: 'user',
        sessionId: 'parent-session',
        timestamp: '2026-07-05T10:01:00.000Z',
        message: {
          role: 'user',
          content:
            '<task-notification>\n<task-id>finished</task-id>\n<status>completed</status>\n</task-notification>'
        }
      },
      {
        // queue-operation records carry the notification as a plain string.
        type: 'queue-operation',
        operation: 'enqueue',
        sessionId: 'parent-session',
        timestamp: '2026-07-05T10:02:00.000Z',
        content:
          '<task-notification>\n<task-id>crashed</task-id>\n<status>failed</status>\n</task-notification>'
      },
      {
        // Synchronous Tasks finish with a toolUseResult record, no notification.
        type: 'user',
        sessionId: 'parent-session',
        timestamp: '2026-07-05T10:03:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_sync', content: 'done' }]
        },
        toolUseResult: { status: 'completed', agentId: 'syncdone', agentType: 'Explore' }
      }
    ])
    for (const agentId of ['finished', 'crashed', 'active', 'stale', 'syncdone']) {
      await writeSubagentTranscript({
        subagentsDir,
        agentId,
        taskPrompt: `Task for ${agentId}`,
        timestamp: '2026-07-05T10:00:10.000Z'
      })
    }
    // A transcript silent for an hour with no terminal notification has no
    // trustworthy status.
    const staleTime = new Date(Date.now() - 60 * 60_000)
    await utimes(join(subagentsDir, 'agent-stale.jsonl'), staleTime, staleTime)

    const result = await listClaudeSubagentSessions({ parentFilePath, platform: 'darwin' })

    expect(result.issues).toEqual([])
    const statusByTitle = Object.fromEntries(
      result.sessions.map((session) => [session.title, session.subagent?.status ?? null])
    )
    expect(statusByTitle).toEqual({
      'Task for finished': 'completed',
      'Task for crashed': 'failed',
      'Task for active': 'running',
      'Task for stale': null,
      'Task for syncdone': 'completed'
    })
    expect(await countSubagentTranscripts(parentFilePath)).toBe(5)
  })

  it('reads a terminal status whose <status> sits past the title truncation limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-subagent-longnote-'))
    tempRoots.push(root)
    const parentFilePath = join(root, 'project', 'parent-session.jsonl')
    const subagentsDir = join(root, 'project', 'parent-session', 'subagents')

    // A real notification carries <tool-use-id>/<output-file> before <status>,
    // pushing <status> well past the 96-char title cap; delivered as a user
    // message it must still be read untruncated so the terminal status wins
    // over the transcript-recency fallback.
    const notification =
      '<task-notification>\n<task-id>bigtask</task-id>\n' +
      '<tool-use-id>toolu_01HB57dwUE6hQVK6Mh8jVFHA</tool-use-id>\n' +
      '<output-file>/private/tmp/claude-501/-Users-me-orca-workspaces-project/' +
      'parent-session/tasks/bigtask.output</output-file>\n' +
      '<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>'
    expect(notification.indexOf('<status>')).toBeGreaterThan(96)

    await writeJsonlFile(parentFilePath, [
      {
        type: 'user',
        sessionId: 'parent-session',
        timestamp: '2026-07-05T10:00:00.000Z',
        cwd: '/tmp/claude',
        message: { role: 'user', content: 'Parent prompt' }
      },
      {
        type: 'user',
        sessionId: 'parent-session',
        timestamp: '2026-07-05T10:01:00.000Z',
        message: { role: 'user', content: notification }
      }
    ])
    // Freshly written, so a dropped status would fall back to 'running' — the
    // assertion below only holds when the notification is parsed untruncated.
    await writeSubagentTranscript({
      subagentsDir,
      agentId: 'bigtask',
      taskPrompt: 'Task for bigtask',
      timestamp: '2026-07-05T10:00:10.000Z'
    })

    const result = await listClaudeSubagentSessions({ parentFilePath, platform: 'darwin' })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.subagent?.status)).toEqual(['completed'])
  })

  it('ignores a quoted notification in a user prompt so it cannot overwrite a real status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-subagent-quoted-'))
    tempRoots.push(root)
    const parentFilePath = join(root, 'project', 'parent-session.jsonl')
    const subagentsDir = join(root, 'project', 'parent-session', 'subagents')

    await writeJsonlFile(parentFilePath, [
      {
        type: 'user',
        sessionId: 'parent-session',
        timestamp: '2026-07-05T10:00:00.000Z',
        message: {
          role: 'user',
          content:
            '<task-notification>\n<task-id>quoted</task-id>\n<status>completed</status>\n</task-notification>'
        }
      },
      {
        // A user prompt that merely quotes an earlier notification must not
        // supersede the real terminal status recorded above.
        type: 'user',
        sessionId: 'parent-session',
        timestamp: '2026-07-05T10:01:00.000Z',
        message: {
          role: 'user',
          content:
            'Re-run: <task-notification>\n<task-id>quoted</task-id>\n<status>failed</status>\n</task-notification>'
        }
      }
    ])
    const staleTime = new Date(Date.now() - 60 * 60_000)
    await writeSubagentTranscript({
      subagentsDir,
      agentId: 'quoted',
      taskPrompt: 'Task for quoted',
      timestamp: '2026-07-05T10:00:10.000Z'
    })
    await utimes(join(subagentsDir, 'agent-quoted.jsonl'), staleTime, staleTime)

    const result = await listClaudeSubagentSessions({ parentFilePath, platform: 'darwin' })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.subagent?.status)).toEqual(['completed'])
  })

  it('reads a sync-Task toolUseResult status even when its report quotes a notification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-subagent-turmarker-'))
    tempRoots.push(root)
    const parentFilePath = join(root, 'project', 'parent-session.jsonl')
    const subagentsDir = join(root, 'project', 'parent-session', 'subagents')

    await writeJsonlFile(parentFilePath, [
      {
        // A sync-Task completion: the terminal status lives in toolUseResult,
        // but the subagent's own report text quotes <task-notification>, so the
        // raw-line prefilter must not misroute it into the notification branch.
        type: 'user',
        sessionId: 'parent-session',
        timestamp: '2026-07-05T10:03:00.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_report',
              content: 'The subagent explained how <task-notification> records work.'
            }
          ]
        },
        toolUseResult: { status: 'completed', agentId: 'reporter', agentType: 'Explore' }
      }
    ])
    // Stale, so a dropped status would fall back to null, not 'completed'.
    const staleTime = new Date(Date.now() - 60 * 60_000)
    await writeSubagentTranscript({
      subagentsDir,
      agentId: 'reporter',
      taskPrompt: 'Task for reporter',
      timestamp: '2026-07-05T10:00:10.000Z'
    })
    await utimes(join(subagentsDir, 'agent-reporter.jsonl'), staleTime, staleTime)

    const result = await listClaudeSubagentSessions({ parentFilePath, platform: 'darwin' })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.subagent?.status)).toEqual(['completed'])
  })

  it('links to the parent derived from its file path even when the transcript has no sessionId', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-subagent-parent-'))
    tempRoots.push(root)
    const parentFilePath = join(root, 'project', 'parent-session.jsonl')
    const subagentsDir = join(root, 'project', 'parent-session', 'subagents')

    // A transcript with no sessionId record: the parser falls back to the
    // subagent's own filename-derived id, so parentSessionId must not use it.
    await writeJsonlFile(join(subagentsDir, 'agent-nosession.jsonl'), [
      {
        type: 'user',
        isSidechain: true,
        agentId: 'nosession',
        timestamp: '2026-07-05T10:01:00.000Z',
        cwd: '/tmp/claude',
        message: { role: 'user', content: 'Orphan subagent prompt' }
      }
    ])

    const result = await listClaudeSubagentSessions({ parentFilePath, platform: 'darwin' })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.subagent?.parentSessionId)).toEqual([
      'parent-session'
    ])
  })

  it('returns an empty list when the session never spawned subagents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-subagent-none-'))
    tempRoots.push(root)
    const parentFilePath = join(root, 'project', 'parent-session.jsonl')
    await writeJsonlFile(parentFilePath, [
      {
        type: 'user',
        sessionId: 'parent-session',
        timestamp: '2026-07-05T10:00:00.000Z',
        cwd: '/tmp/claude',
        message: { role: 'user', content: 'Parent prompt' }
      }
    ])

    const result = await listClaudeSubagentSessions({ parentFilePath, platform: 'darwin' })

    expect(result).toEqual({ sessions: [], issues: [] })
  })
})
