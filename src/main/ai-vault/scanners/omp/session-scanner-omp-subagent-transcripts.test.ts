import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseMessageGraphSessionContent } from '../session-scanner-graph-parsers'

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
    // A same-path local artifact directory must not enrich a transcript fetched from an SSH host.
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
