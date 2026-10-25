import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, writeJsonlFile } from './session-scanner-test-fixtures'

const OMP_STEM = '2026-05-01T10-00-00-000Z_0199a000-0000-7000-8000-000000000002'
const runtime = { version: '18.12.2' }

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

// Shapes follow what Pi 0.84 and OMP 18.12 write: OMP adds a title slot and runtime stamps.
async function writeSharedRootTranscripts(sessionsDir: string): Promise<void> {
  const piDir = join(sessionsDir, '--repo-app--')
  await writeJsonlFile(join(piDir, '2026-05-01T09-00-00-000Z_pi.jsonl'), [
    {
      type: 'session',
      version: 3,
      id: '0199a000-0000-7000-8000-000000000001',
      timestamp: '2026-05-01T09:00:00.000Z',
      cwd: '/repo/app'
    },
    {
      type: 'model_change',
      id: 'a1',
      parentId: null,
      timestamp: '2026-05-01T09:00:00.100Z',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5'
    },
    {
      type: 'message',
      id: 'a2',
      parentId: 'a1',
      timestamp: '2026-05-01T09:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Pi prompt' }] }
    }
  ])
  const ompDir = join(sessionsDir, '-repo-app')
  await writeJsonlFile(join(ompDir, `${OMP_STEM}.jsonl`), [
    {
      type: 'title',
      v: 1,
      title: 'OMP named chat',
      source: 'user',
      updatedAt: '2026-05-01T10:00:02.000Z'
    },
    {
      type: 'session',
      version: 3,
      id: '0199a000-0000-7000-8000-000000000002',
      timestamp: '2026-05-01T10:00:00.000Z',
      cwd: '/repo/app'
    },
    {
      type: 'model_change',
      id: 'b1',
      parentId: null,
      timestamp: '2026-05-01T10:00:00.100Z',
      model: 'anthropic/claude-sonnet-4-5',
      runtime
    },
    {
      type: 'message',
      id: 'b2',
      parentId: 'b1',
      timestamp: '2026-05-01T10:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'OMP prompt' }] },
      runtime
    }
  ])
  // Older OMP builds wrote no title slot or runtime stamps, only the header name and model_change.model.
  await writeJsonlFile(join(ompDir, '2026-04-01T10-00-00-000Z_legacy.jsonl'), [
    {
      type: 'session',
      version: 3,
      id: '0199a000-0000-7000-8000-000000000004',
      title: 'Legacy OMP name',
      timestamp: '2026-04-01T10:00:00.000Z',
      cwd: '/repo/app'
    },
    { type: 'model_change', timestamp: '2026-04-01T10:00:00.100Z', model: 'gpt-5.4-mini' },
    {
      type: 'message',
      timestamp: '2026-04-01T10:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Legacy prompt' }] }
    }
  ])
  await writeJsonlFile(join(ompDir, OMP_STEM, 'Worker.jsonl'), [
    {
      type: 'session',
      version: 3,
      id: '0199a000-0000-7000-8000-000000000003',
      timestamp: '2026-05-01T10:00:05.000Z',
      cwd: '/repo/app'
    },
    {
      type: 'message',
      id: 'c1',
      parentId: null,
      timestamp: '2026-05-01T10:00:06.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Worker task' }] },
      runtime
    }
  ])
}

describe('scanAiVaultSessions with overlapping Pi and OMP roots', () => {
  const sameFolder = (sessionsDir: string): string => sessionsDir
  it.each([
    { layout: 'the same folder', piRoot: sameFolder, scope: {} },
    // PI_CODING_AGENT_DIR=<dir>: Pi walks <dir>, OMP walks <dir>/sessions.
    { layout: 'a parent folder', piRoot: (dir: string) => join(dir, '..'), scope: {} },
    // A one-row cap sends the rest through scope recovery: Pi's buckets and OMP's walk.
    {
      layout: 'the same folder for a workspace',
      piRoot: sameFolder,
      scope: { scopePaths: ['/repo/app'], limit: 1 }
    }
  ])('lists each transcript once under its writer when Pi scans $layout', async (testCase) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-pi-omp-shared-'))
    tempRoots.push(root)
    const sessionsDir = join(root, 'agent', 'sessions')
    await writeSharedRootTranscripts(sessionsDir)

    const result = await scanAiVaultSessions({
      ...isolatedScanRoots(root),
      ...testCase.scope,
      piSessionsDir: testCase.piRoot(sessionsDir),
      ompSessionsDir: sessionsDir,
      platform: 'linux'
    })

    expect(
      result.sessions
        .map((session) => [session.agent, session.title, session.subagentTranscriptCount])
        .sort()
    ).toEqual([
      ['omp', 'Legacy OMP name', 0],
      ['omp', 'OMP named chat', 1],
      ['pi', 'Pi prompt', 0]
    ])
  })
})
