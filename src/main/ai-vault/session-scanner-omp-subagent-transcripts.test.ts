import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseMessageGraphSessionContent } from './session-scanner-graph-parsers'
import {
  OMP_SESSION_ARTIFACT_DIR_PATTERN,
  countOmpSubagentTranscripts,
  partitionOmpSubagentTranscriptPaths
} from './session-scanner-omp-subagent-transcripts'

const SESSION_STEM = '2026-05-01T10-00-00-000Z_cccccccc-dddd-4eee-8fff-000000000000'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function makeWorkspaceDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-omp-subagents-'))
  tempRoots.push(root)
  return root
}

describe('OMP_SESSION_ARTIFACT_DIR_PATTERN', () => {
  it('matches session artifact dir names and nothing else in the layout', () => {
    expect(OMP_SESSION_ARTIFACT_DIR_PATTERN.test(SESSION_STEM)).toBe(true)
    // Task children are label-named.
    expect(OMP_SESSION_ARTIFACT_DIR_PATTERN.test('AuthAndPreflight')).toBe(false)
    expect(OMP_SESSION_ARTIFACT_DIR_PATTERN.test('local')).toBe(false)
    // Workspace dir names OMP encodes from a cwd (relative to home, relative to
    // tmp, absolute, or slug-hashed) never collide with a session stem. The
    // local prune doesn't depend on this — it skips depth 0 — but the remote
    // partition has no root to measure depth against, so it does.
    for (const workspaceDirName of [
      `-${SESSION_STEM}`,
      `-tmp-${SESSION_STEM}`,
      `--${SESSION_STEM}--`,
      'home-app-85dfa2f063812c58976deb581167a634a4'
    ]) {
      expect(OMP_SESSION_ARTIFACT_DIR_PATTERN.test(workspaceDirName)).toBe(false)
    }
  })
})

describe('countOmpSubagentTranscripts', () => {
  it('counts only direct-child transcripts of the artifact dir', async () => {
    const workspace = await makeWorkspaceDir()
    const parentPath = join(workspace, `${SESSION_STEM}.jsonl`)
    const artifactDir = join(workspace, SESSION_STEM)
    await mkdir(join(artifactDir, 'local'), { recursive: true })
    await writeFile(parentPath, '')
    await writeFile(join(artifactDir, 'AuthAndPreflight.jsonl'), '')
    await writeFile(join(artifactDir, 'BitbucketDcApi.jsonl'), '')
    // Artifacts are not transcripts; nested files belong to their own parents.
    await writeFile(join(artifactDir, 'notes.md'), '')
    await writeFile(join(artifactDir, 'local', 'plan.jsonl'), '')

    await expect(countOmpSubagentTranscripts(parentPath)).resolves.toBe(2)
  })

  it('returns 0 when the session never delegated (no artifact dir)', async () => {
    const workspace = await makeWorkspaceDir()
    const parentPath = join(workspace, `${SESSION_STEM}.jsonl`)
    await writeFile(parentPath, '')

    await expect(countOmpSubagentTranscripts(parentPath)).resolves.toBe(0)
  })
})

describe('partitionOmpSubagentTranscriptPaths', () => {
  it('drops artifact-dir transcripts from candidates and counts them per parent', () => {
    const workspace = `/home/user/.omp/agent/sessions/home-app-85dfa2f0`
    const parent = `${workspace}/${SESSION_STEM}.jsonl`
    const sibling = `${workspace}/2026-05-02T09-00-00-000Z_dddddddd-eeee-4fff-8aaa-111111111111.jsonl`
    const partition = partitionOmpSubagentTranscriptPaths([
      parent,
      `${workspace}/${SESSION_STEM}/AuthAndPreflight.jsonl`,
      `${workspace}/${SESSION_STEM}/BitbucketDcApi.jsonl`,
      // A grandchild attributes to its own parent, not the top-level session —
      // and never surfaces as a candidate.
      `${workspace}/${SESSION_STEM}/AuthAndPreflight/Nested.jsonl`,
      sibling
    ])

    expect(partition.sessionFilePaths).toEqual([parent, sibling])
    expect(partition.subagentTranscriptCounts.get(parent)).toBe(2)
    expect(partition.subagentTranscriptCounts.size).toBe(1)
  })

  it('attributes a child to its nearest stamped ancestor, not the outermost one', () => {
    const workspace = '/home/user/.omp/agent/sessions/home-app-85dfa2f0'
    const nested = '2026-05-02T09-00-00-000Z_dddddddd-eeee-4fff-8aaa-111111111111'
    const partition = partitionOmpSubagentTranscriptPaths([
      `${workspace}/${SESSION_STEM}/${nested}/Grandchild.jsonl`
    ])

    expect(partition.sessionFilePaths).toEqual([])
    expect([...partition.subagentTranscriptCounts]).toEqual([
      [`${workspace}/${SESSION_STEM}/${nested}.jsonl`, 1]
    ])
  })

  it('handles Windows separators', () => {
    const workspace = `C:\\Users\\u\\.omp\\agent\\sessions\\home-app-85dfa2f0`
    const parent = `${workspace}\\${SESSION_STEM}.jsonl`
    const partition = partitionOmpSubagentTranscriptPaths([
      parent,
      `${workspace}\\${SESSION_STEM}\\AuthAndPreflight.jsonl`
    ])

    expect(partition.sessionFilePaths).toEqual([parent])
    expect(partition.subagentTranscriptCounts.get(parent)).toBe(1)
  })
})

describe('withOmpSubagentTranscriptCount host gating', () => {
  const content = JSON.stringify({
    type: 'session',
    version: 3,
    id: 'cccccccc-dddd-4eee-8fff-000000000000',
    cwd: '/repo/app',
    timestamp: '2026-05-01T10:00:00.000Z'
  })

  it('never counts a local artifact dir for a remote-host transcript', async () => {
    const workspace = await makeWorkspaceDir()
    const parentPath = join(workspace, `${SESSION_STEM}.jsonl`)
    // A local artifact dir exists at the same path, but the content came from
    // an SSH host — its real task children live on that host, not on this disk.
    await mkdir(join(workspace, SESSION_STEM), { recursive: true })
    await writeFile(join(workspace, SESSION_STEM, 'AuthAndPreflight.jsonl'), '')
    const file = { path: parentPath, mtimeMs: 0, modifiedAt: '2026-05-01T10:00:00.000Z' }

    const remote = await parseMessageGraphSessionContent('omp', file, content, 'linux', {
      executionHostId: 'ssh:host'
    })
    const local = await parseMessageGraphSessionContent('omp', file, content, 'darwin')

    expect(remote?.subagentTranscriptCount).toBe(0)
    expect(local?.subagentTranscriptCount).toBe(1)
  })
})
