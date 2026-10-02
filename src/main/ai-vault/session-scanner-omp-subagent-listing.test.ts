import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listOmpSubagentSessions } from './session-scanner-omp-subagent-listing'

const SESSION_STEM = '2026-05-01T10-00-00-000Z_cccccccc-dddd-4eee-8fff-000000000000'
const PARENT_SESSION_ID = 'cccccccc-dddd-4eee-8fff-000000000000'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

function childTranscript(id: string, timestamp: string, prompt: string): string {
  return [
    JSON.stringify({ type: 'session', version: 3, id, cwd: '/repo/app', timestamp }),
    JSON.stringify({ type: 'message', timestamp, message: { role: 'user', content: prompt } })
  ].join('\n')
}

describe('listOmpSubagentSessions', () => {
  it('keeps flat descendants under their parent and uses provider results rather than yield-aborted tails', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-omp-nested-'))
    tempRoots.push(workspace)
    const parentPath = join(workspace, `${SESSION_STEM}.jsonl`)
    const artifactDir = join(workspace, SESSION_STEM)
    await mkdir(artifactDir)
    const timestamp = '2026-05-01T10:02:00.000Z'
    const result = (id: string, exitCode: number, aborted = false) =>
      JSON.stringify({
        type: 'message',
        timestamp,
        message: {
          role: 'toolResult',
          toolName: 'task',
          details: { results: [{ id, exitCode, aborted }] }
        }
      })
    await writeFile(parentPath, result('Worker', 0))
    await writeFile(
      join(artifactDir, 'Worker.jsonl'),
      [
        childTranscript('worker-session', '2026-05-01T10:01:00.000Z', 'Run children'),
        JSON.stringify({ type: 'session_init', agent: 'worker' }),
        JSON.stringify({
          type: 'message',
          timestamp,
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', name: 'task' }],
            stopReason: 'toolUse'
          }
        }),
        result('Worker.Done', 0),
        result('Worker.Failed', 1),
        result('Worker.Stopped', 1, true),
        JSON.stringify({
          type: 'message',
          timestamp,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Finished' }],
            stopReason: 'aborted'
          }
        })
      ].join('\n')
    )
    for (const name of ['Done', 'Failed', 'Stopped']) {
      await writeFile(
        join(artifactDir, `Worker.${name}.jsonl`),
        childTranscript(name, timestamp, 'Child prompt')
      )
    }
    await writeFile(
      join(artifactDir, 'Worker.Done.Nested.jsonl'),
      childTranscript('deep', timestamp, 'Deep prompt')
    )
    const root = await listOmpSubagentSessions({ parentFilePath: parentPath })
    expect(root.sessions).toHaveLength(1)
    expect(root.sessions[0]).toMatchObject({
      title: 'Worker',
      messageCount: 2,
      subagentTranscriptCount: 3,
      subagent: { status: 'completed', agentType: 'worker' }
    })
    const children = await listOmpSubagentSessions({
      parentFilePath: join(artifactDir, 'Worker.jsonl')
    })
    expect(children.sessions.map((s) => [s.title, s.subagent?.status]).sort()).toEqual([
      ['Worker.Done', 'completed'],
      ['Worker.Failed', 'failed'],
      ['Worker.Stopped', 'stopped']
    ])
    expect(children.sessions.find((s) => s.title === 'Worker.Done')?.subagentTranscriptCount).toBe(
      1
    )
  })

  it('does not reuse a previous task result after the child receives another prompt', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-omp-revived-'))
    tempRoots.push(workspace)
    const parentPath = join(workspace, `${SESSION_STEM}.jsonl`)
    const artifactDir = join(workspace, SESSION_STEM)
    await mkdir(artifactDir)
    await writeFile(
      parentPath,
      JSON.stringify({
        type: 'message',
        timestamp: '2026-05-01T10:00:00Z',
        message: {
          role: 'toolResult',
          toolName: 'task',
          details: { results: [{ id: 'Worker', exitCode: 0 }] }
        }
      })
    )
    await writeFile(
      join(artifactDir, 'Worker.jsonl'),
      childTranscript('worker', '2026-05-01T10:01:00Z', 'New prompt')
    )
    const result = await listOmpSubagentSessions({ parentFilePath: parentPath })
    expect(result.sessions[0]?.subagent?.status).toBeNull()
  })

  it('retains older nested-directory transcripts without exposing grandchildren in the root list', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-omp-legacy-'))
    tempRoots.push(workspace)
    const parentPath = join(workspace, `${SESSION_STEM}.jsonl`)
    const artifactDir = join(workspace, SESSION_STEM)
    await mkdir(join(artifactDir, 'Worker'), { recursive: true })
    await writeFile(parentPath, '')
    await writeFile(
      join(artifactDir, 'Worker.jsonl'),
      childTranscript('worker', '2026-05-01T10:00:00Z', 'Parent task')
    )
    await writeFile(
      join(artifactDir, 'Worker', 'Nested.jsonl'),
      childTranscript('nested', '2026-05-01T10:00:01Z', 'Nested task')
    )
    const root = await listOmpSubagentSessions({ parentFilePath: parentPath })
    expect(root.sessions.map((s) => s.title)).toEqual(['Worker'])
    expect(root.sessions[0]?.subagentTranscriptCount).toBe(1)
    const nested = await listOmpSubagentSessions({
      parentFilePath: join(artifactDir, 'Worker.jsonl')
    })
    expect(nested.sessions.map((s) => s.title)).toEqual(['Nested'])
    expect(nested.sessions[0]?.subagent?.parentSessionId).toBe('worker')
  })

  it('uses explicit progress for a silent running child and leaves an unreported child unknown', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-omp-progress-'))
    tempRoots.push(workspace)
    const parentPath = join(workspace, `${SESSION_STEM}.jsonl`)
    const artifactDir = join(workspace, SESSION_STEM)
    await mkdir(artifactDir)
    await writeFile(
      parentPath,
      JSON.stringify({
        type: 'message',
        timestamp: '2026-05-01T10:00:00Z',
        message: {
          role: 'toolResult',
          toolName: 'task',
          details: { progress: [{ id: 'Running', status: 'running' }] }
        }
      })
    )
    for (const id of ['Running', 'Unknown']) {
      await writeFile(
        join(artifactDir, `${id}.jsonl`),
        childTranscript(id, '2026-05-01T10:00:00Z', 'Wait')
      )
    }
    const result = await listOmpSubagentSessions({ parentFilePath: parentPath })
    expect(result.sessions.find((s) => s.title === 'Running')?.subagent?.status).toBe('running')
    expect(result.sessions.find((s) => s.title === 'Unknown')?.subagent?.status).toBeNull()
  })
  it('lists artifact-dir transcripts under the parent, titled by task label', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-omp-subagent-list-'))
    tempRoots.push(workspace)
    const parentPath = join(workspace, `${SESSION_STEM}.jsonl`)
    const artifactDir = join(workspace, SESSION_STEM)
    await mkdir(join(artifactDir, 'local'), { recursive: true })
    await writeFile(parentPath, '')
    await writeFile(
      join(artifactDir, 'AuthAndPreflight.jsonl'),
      childTranscript(
        'aaaaaaaa-bbbb-4ccc-8ddd-222222222222',
        '2026-05-01T10:01:00.000Z',
        'Map the auth surface'
      )
    )
    await writeFile(
      join(artifactDir, 'BitbucketDcApi.jsonl'),
      childTranscript(
        'aaaaaaaa-bbbb-4ccc-8ddd-333333333333',
        '2026-05-01T10:02:00.000Z',
        'Read the DC API spec'
      )
    )
    // Artifacts are not transcripts; nested files belong to their own parents.
    await writeFile(join(artifactDir, 'notes.md'), 'not a transcript')
    await writeFile(join(artifactDir, 'local', 'plan.jsonl'), '{}')

    const result = await listOmpSubagentSessions({
      parentFilePath: parentPath,
      platform: 'darwin'
    })

    expect(result.issues).toEqual([])
    // Newest first, titled by the coordinator-given task label, each linked to
    // the parent derived from the layout (not the child's own session record).
    expect(
      result.sessions.map((session) => ({
        title: session.title,
        parent: session.subagent?.parentSessionId
      }))
    ).toEqual([
      { title: 'BitbucketDcApi', parent: PARENT_SESSION_ID },
      { title: 'AuthAndPreflight', parent: PARENT_SESSION_ID }
    ])
  })

  it('resolves empty for a session that never delegated', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-omp-subagent-list-'))
    tempRoots.push(workspace)
    const parentPath = join(workspace, `${SESSION_STEM}.jsonl`)
    await writeFile(parentPath, '')

    await expect(
      listOmpSubagentSessions({ parentFilePath: parentPath, platform: 'darwin' })
    ).resolves.toEqual({ sessions: [], issues: [] })
  })
  it('traverses each saved generation through its own transcript without flattening descendants', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-omp-nested-list-'))
    tempRoots.push(workspace)
    const parentPath = join(workspace, `${SESSION_STEM}.jsonl`)
    const childPath = join(workspace, SESSION_STEM, 'Worker.jsonl')
    const grandchildPath = join(workspace, SESSION_STEM, 'Worker', 'Research.jsonl')
    await mkdir(join(workspace, SESSION_STEM, 'Worker'), { recursive: true })
    await writeFile(
      parentPath,
      childTranscript(PARENT_SESSION_ID, '2026-05-01T10:00:00Z', 'Coordinate')
    )
    await writeFile(
      childPath,
      childTranscript('worker-id', '2026-05-01T10:01:00Z', 'Delegate research')
    )
    await writeFile(
      grandchildPath,
      childTranscript('research-id', '2026-05-01T10:02:00Z', 'Investigate')
    )
    const children = await listOmpSubagentSessions({ parentFilePath: parentPath })
    expect(children.issues).toEqual([])
    expect(children.sessions).toHaveLength(1)
    expect(children.sessions[0]).toMatchObject({
      filePath: childPath,
      sessionId: 'worker-id',
      subagentTranscriptCount: 1
    })
    const grandchildren = await listOmpSubagentSessions({
      parentFilePath: children.sessions[0].filePath
    })
    expect(grandchildren.issues).toEqual([])
    expect(grandchildren.sessions).toHaveLength(1)
    expect(grandchildren.sessions[0]).toMatchObject({
      filePath: grandchildPath,
      sessionId: 'research-id',
      subagentTranscriptCount: 0
    })
  })
})
