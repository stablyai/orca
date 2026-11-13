import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import { FULL_SHARD_COUNT } from './ci-unit-matrix.mjs'

it('emits the full matrix from a sparse checkout without dependencies or test discovery', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-unit-matrix-')))
  try {
    const script = join(root, 'matrix.mjs')
    copyFileSync(new URL('./ci-unit-matrix.mjs', import.meta.url), script)
    const output = join(root, 'outputs')
    const run = (count) =>
      runProcessSync({
        program: process.execPath,
        args: [script],
        cwd: root,
        env: {
          ...process.env,
          ORCA_UNIT_FULL_SHARD_COUNT: count,
          GITHUB_OUTPUT: output
        }
      })
    const result = run('16')
    expect(result.code, result.stderr).toBe(0)
    const shards = JSON.parse(readFileSync(output, 'utf8').trim().slice('shards='.length))
    expect(shards).toEqual(
      Array.from({ length: 16 }, (_, index) => ({ index: index + 1, count: 16 }))
    )
    expect(run('2; echo unsafe').code).not.toBe(0)
    expect(readFileSync(output, 'utf8').trim()).toBe(`shards=${JSON.stringify(shards)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it.each([
  { withParent: true, unresolvedPackage: false },
  { withParent: false, unresolvedPackage: false },
  { withParent: true, unresolvedPackage: true }
])(
  'plans from a real Git diff, retaining full coverage for incomplete package evidence: %j',
  ({ withParent, unresolvedPackage }) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-unit-plan-'))
    const git = (args) => {
      const result = runProcessSync({ program: 'git', args, cwd: root })
      expect(result.code, result.stderr).toBe(0)
      return result.stdout.trim()
    }
    try {
      mkdirSync(join(root, 'src'))
      writeFileSync(join(root, 'src/value.ts'), 'export const value = 1')
      writeFileSync(
        join(root, 'src/consumer.test.ts'),
        unresolvedPackage ? "import '@orca/missing-package'" : "import './value'"
      )
      writeFileSync(join(root, 'src/unrelated.test.ts'), 'export const unrelated = true')
      git(['init', '--quiet'])
      git(['add', 'src'])
      const commit = [
        '-c',
        'user.name=CI Test',
        '-c',
        'user.email=ci-test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        'fixture'
      ]
      git(commit)
      if (withParent) {
        writeFileSync(join(root, 'src/value.ts'), 'export const value = 2')
        git(['add', 'src'])
        git(commit)
      }
      const sourceSha = git(['rev-parse', 'HEAD'])
      const result = runProcessSync({
        program: process.execPath,
        args: [fileURLToPath(new URL('./ci-unit-plan.mjs', import.meta.url))],
        cwd: root,
        env: {
          ...process.env,
          ORCA_BACKGROUND_LAUNCH: '1',
          ORCA_UNIT_SELECTION_MODE: 'selected',
          GITHUB_EVENT_NAME: 'pull_request',
          ORCA_PULL_REQUEST_DRAFT: 'true',
          GITHUB_SHA: sourceSha,
          ORCA_SHARD_SOURCE_SHA: sourceSha,
          GITHUB_OUTPUT: join(root, 'outputs'),
          GITHUB_STEP_SUMMARY: join(root, 'summary')
        }
      })
      expect(result.code, result.stderr).toBe(0)
      const plan = JSON.parse(readFileSync(join(root, 'ci-shards/unit-selection.json'), 'utf8'))
      expect(plan.sourceSha).toBe(sourceSha)
      const selected = withParent && !unresolvedPackage
      expect(plan.mode).toBe(selected ? 'selected' : 'shadow')
      expect(plan.executionFiles).toEqual(
        selected ? ['src/consumer.test.ts'] : ['src/consumer.test.ts', 'src/unrelated.test.ts']
      )
      expect(plan.reason).toBe(
        !withParent
          ? 'Error: Changed paths unavailable'
          : unresolvedPackage
            ? 'Error: No public orca-source export for @orca/missing-package'
            : 'Transitive imports plus indirect-input consumers'
      )
      expect(plan.shards).toHaveLength(selected ? 1 : FULL_SHARD_COUNT)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
