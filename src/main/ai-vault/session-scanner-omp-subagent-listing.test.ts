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
})
