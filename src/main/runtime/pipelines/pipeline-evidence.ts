import { createHash } from 'node:crypto'
import { lstat, open, readlink, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { runProcess } from '@orca/process-host'
import type { PipelineRun, PipelineCheck } from '../../../shared/pipelines/pipeline-contracts'
import type {
  PipelineCheckResult,
  PipelineStageEvidence
} from '../../../shared/pipelines/pipeline-stage-evidence'

async function git(path: string, args: string[]): Promise<string> {
  const result = await runProcess({
    program: 'git',
    args,
    cwd: path,
    timeoutMs: 30000,
    maxOutputBytes: 2 * 1024 * 1024,
    killOnOutputLimit: true
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error('pipeline_git_evidence_unavailable')
  }
  return result.stdout
}

export async function pipelineSourceRevision(workspace: PipelineRun['workspace']): Promise<string> {
  const hash = createHash('sha256')
  hash.update(JSON.stringify(await git(workspace.path, ['rev-parse', 'HEAD'])))
  // Read actual tracked bytes too: Git's assume-unchanged/skip-worktree flags can hide edits from diff.
  const names = [
    ...new Set(
      (await git(workspace.path, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']))
        .split('\0')
        .filter(Boolean)
    )
  ]
  if (names.length > 20000) {
    throw new Error('pipeline_source_limit')
  }
  const root = await realpath(workspace.path)
  let bytes = 0
  for (const name of names.sort()) {
    const file = resolve(workspace.path, name)
    const inside = relative(workspace.path, file)
    if (inside.startsWith('..') || isAbsolute(inside)) {
      throw new Error('pipeline_artifact_path')
    }
    const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return null
      }
      throw error
    })
    hash.update(
      JSON.stringify({
        name,
        kind: stat?.isSymbolicLink() ? 'link' : stat ? 'file' : 'missing',
        size: stat?.size,
        mode: stat?.mode
      })
    )
    if (!stat) {
      continue
    }
    bytes += stat.size
    if (bytes > 256 * 1024 * 1024) {
      throw new Error('pipeline_source_limit')
    }
    if (stat.isSymbolicLink()) {
      hash.update(JSON.stringify(await readlink(file)))
      continue
    }
    if (!stat.isFile()) {
      throw new Error('pipeline_non_regular_source')
    }
    const target = relative(root, await realpath(file))
    if (target.startsWith('..') || isAbsolute(target)) {
      throw new Error('pipeline_artifact_path')
    }
    const handle = await open(
      file,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
    )
    try {
      let readBytes = 0
      const opened = await handle.stat()
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) {
        throw new Error('pipeline_source_changed_during_read')
      }
      const buffer = Buffer.alloc(65536)
      while (true) {
        const chunk = await handle.read(buffer, 0, buffer.length, null)
        if (!chunk.bytesRead) {
          break
        }
        readBytes += chunk.bytesRead
        if (readBytes > stat.size) {
          throw new Error('pipeline_source_changed_during_read')
        }
        hash.update(buffer.subarray(0, chunk.bytesRead))
      }
      const after = await handle.stat()
      if (readBytes !== stat.size || after.mtimeMs !== stat.mtimeMs || after.size !== stat.size) {
        throw new Error('pipeline_source_changed_during_read')
      }
    } finally {
      await handle.close()
    }
  }
  return hash.digest('hex')
}

export async function pipelineCommit(path: string): Promise<string> {
  const commit = (await git(path, ['rev-parse', '--verify', 'HEAD'])).trim()
  if (!/^[a-f0-9]{40,64}$/.test(commit)) {
    throw new Error('pipeline_commit_unavailable')
  }
  return commit
}

export async function pipelineReviewCommit(workspace: PipelineRun['workspace']): Promise<string> {
  const files = (await git(workspace.path, ['ls-files', '-v', '-z'])).split('\0').filter(Boolean)
  if (files.some((file) => /^[a-zS]/.test(file))) {
    throw new Error('pipeline_review_source_flags_unverifiable')
  }
  if (
    (await git(workspace.path, ['status', '--porcelain=v1', '--untracked-files=normal'])).trim()
  ) {
    throw new Error('pipeline_review_requires_clean_commit')
  }
  return pipelineCommit(workspace.path)
}

export async function validatePipelineFileEvidence(
  run: Pick<PipelineRun, 'workspace' | 'baseCommit'>,
  evidence: PipelineStageEvidence
): Promise<void> {
  if (evidence.stage !== 'docs' || evidence.files.length === 0) {
    return
  }
  if (!run.baseCommit) {
    throw new Error('pipeline_base_commit_missing')
  }
  const files = new Set(
    (
      await git(run.workspace.path, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--name-only',
        '-z',
        run.baseCommit,
        '--'
      ])
    ).split('\0')
  )
  for (const name of (
    await git(run.workspace.path, ['ls-files', '--others', '--exclude-standard', '-z'])
  ).split('\0')) {
    files.add(name)
  }
  if (evidence.files.some((name) => !files.has(name))) {
    throw new Error('pipeline_documentation_evidence_missing')
  }
}

export async function runPipelineChecks(
  run: Pick<PipelineRun, 'workspace'> & { profile: { checks: string[] } },
  definitions: PipelineCheck[]
) {
  const output: string[] = []
  let passed = true
  let uncertain = false
  const results: PipelineCheckResult[] = []
  for (const id of run.profile.checks) {
    const definition = definitions.find((item) => item.id === id)
    if (!definition) {
      throw new Error('pipeline_check_unconfigured')
    }
    const result = await runProcess({
      program: definition.program,
      args: definition.args,
      cwd: run.workspace.path,
      timeoutMs: definition.timeoutMs,
      maxOutputBytes: 32000,
      killOnOutputLimit: true
    })
    passed &&= result.code === 0 && !result.timedOut && !result.outputTruncated
    uncertain ||= result.code === null || result.timedOut || result.outputTruncated === true
    results.push({
      id,
      code: result.code,
      timedOut: result.timedOut,
      outputTruncated: result.outputTruncated === true
    })
    output.push(
      `${id}: exit=${result.code} timeout=${result.timedOut}\n${result.stdout}\n${result.stderr}`
    )
    if (uncertain) {
      break
    }
  }
  return { passed, uncertain, results, body: output.join('\n').slice(0, 8000) }
}
