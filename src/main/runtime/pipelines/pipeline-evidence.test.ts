import { mkdtemp, writeFile, rm, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, expect, it } from 'vitest'
import {
  pipelineSourceRevision,
  runPipelineChecks,
  pipelineReviewCommit
} from './pipeline-evidence'
import { PipelineStore, pipelineDigest } from './pipeline-store'
import { bindAdmittedPipeline } from './pipeline-admitted-run'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function repository() {
  const path = await mkdtemp(join(tmpdir(), 'orca-pipeline-evidence-'))
  roots.push(path)
  const git = async (...args: string[]) => {
    const result = await runProcess({ program: 'git', args, cwd: path, timeoutMs: 10000 })
    if (result.code !== 0) {
      throw new Error(result.stderr)
    }
  }
  await git('init', '-q')
  await writeFile(join(path, 'tracked.txt'), 'initial\n')
  await git('add', 'tracked.txt')
  await git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'initial'
  )
  const workspace = {
    id: 'repo::task',
    instanceId: 'instance',
    projectId: 'repo',
    hostId: 'local' as const,
    path
  }
  return { path, git, workspace }
}

it('distinguishes untracked file names and contents with the same concatenation', async () => {
  const { path, workspace } = await repository()
  await writeFile(join(path, 'a'), 'bc')
  const before = await pipelineSourceRevision(workspace)
  await rename(join(path, 'a'), join(path, 'ab'))
  await writeFile(join(path, 'ab'), 'c')
  expect(await pipelineSourceRevision(workspace)).not.toBe(before)
})

it('detects edits even when a tracked file is marked assume-unchanged', async () => {
  const { path, git, workspace } = await repository()
  await git('update-index', '--assume-unchanged', 'tracked.txt')
  await expect(pipelineReviewCommit(workspace)).rejects.toThrow(
    'pipeline_review_source_flags_unverifiable'
  )
  const before = await pipelineSourceRevision(workspace)
  await writeFile(join(path, 'tracked.txt'), 'changed\n')
  expect(await pipelineSourceRevision(workspace)).not.toBe(before)
})

it('requires a clean commit for review and returns its actual Git identity', async () => {
  const { path, git, workspace } = await repository()
  const initial = await pipelineReviewCommit(workspace)
  expect(initial).toMatch(/^[a-f0-9]{40}$/)
  await writeFile(join(path, 'tracked.txt'), 'task change\n')
  await expect(pipelineReviewCommit(workspace)).rejects.toThrow(
    'pipeline_review_requires_clean_commit'
  )
  await git('add', 'tracked.txt')
  await git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'task'
  )
  expect(await pipelineReviewCommit(workspace)).not.toBe(initial)
})

it('passes literal check argv and refuses missing definitions', async () => {
  const { workspace } = await repository()
  const store = new PipelineStore(':memory:')
  try {
    const run = store.create({
      requestId: 'r',
      workspace,
      task: 'Test literal args',
      profile: {
        id: 'standard',
        version: '1',
        title: 'Development',
        checks: ['test'],
        maxFixCycles: 2,
        roles: { primary: { agent: 'codex' }, reviewer: { agent: 'codex' } }
      }
    })
    const result = await runPipelineChecks(run, [
      {
        id: 'test',
        program: process.execPath,
        args: ['-e', 'process.stdout.write(process.argv[1])', '$(touch injected); exit 1'],
        timeoutMs: 1000
      }
    ])
    expect(result.passed).toBe(true)
    expect(result.body).toContain('$(touch injected); exit 1')
    await expect(runPipelineChecks(run, [])).rejects.toThrow('pipeline_check_unconfigured')
  } finally {
    store.close()
  }
})

it('binds the admitted definition and checks even when project settings change after admission', async () => {
  const { workspace } = await repository()
  const store = new PipelineStore(':memory:')
  try {
    const profile = {
      id: 'standard',
      version: '1',
      title: 'Development',
      checks: ['test'],
      maxFixCycles: 2,
      roles: { primary: { agent: 'codex' }, reviewer: { agent: 'codex' } }
    }
    const snapshot = {
      profile,
      provider: { pluginKey: 'samples.pipelines', fingerprint: 'approved' },
      checkSnapshot: [{ id: 'test', program: 'node', args: ['--test'], timeoutMs: 1000 }]
    }
    store.reserveCreation('creation', { task: 'Fix delivery' }, snapshot)
    store.configureChecks('repo', [])
    const run = await bindAdmittedPipeline(
      store,
      {
        id: workspace.id,
        repoId: workspace.projectId,
        instanceId: workspace.instanceId,
        path: workspace.path
      },
      { id: 'samples.pipelines/standard', version: '1', digest: pipelineDigest(profile) },
      'Fix delivery',
      'create:creation'
    )
    expect(run.profile).toEqual(profile)
    expect(run.provider).toEqual({ pluginKey: 'samples.pipelines', fingerprint: 'approved' })
    expect(run.checkSnapshot).toEqual([
      { id: 'test', program: 'node', args: ['--test'], timeoutMs: 1000 }
    ])
    expect(run.state).toBe('waiting_setup')
  } finally {
    store.close()
  }
})
