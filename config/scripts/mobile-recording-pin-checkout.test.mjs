import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcessSync } from './script-child-process.mjs'

const workflow = parse(
  readFileSync(new URL('../../.github/workflows/mobile.yml', import.meta.url), 'utf8')
)

it('keeps full ancestry and credentials for lazy pinned-tree reads', () => {
  const job = workflow.jobs['recording-pin']
  const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'))
  expect(checkout.with['fetch-depth']).toBe(0)
  expect(checkout.with.filter).toBe('blob:none')
  expect(checkout.with['persist-credentials']).not.toBe(false)
  expect(job.if).toBeUndefined()
  expect(workflow.on.push.branches).toEqual(['main'])
  expect(workflow.concurrency.group).toContain('github.sha')
  expect(job.steps.find((step) => step.name === 'Check the recording pin is reachable').run).toBe(
    'pnpm exec tsx scripts/rpc-recording-pin-guard.mts ancestry'
  )
  const reproduce = job.steps.find(
    (step) => step.name === 'Reproduce the corpus from the pinned tree'
  )
  expect(reproduce.run).toContain('reproduce --if-changed-since "$PIN_GUARD_BASE"')
  expect(reproduce.run).toContain(
    'else\n  pnpm exec tsx scripts/rpc-recording-pin-guard.mts reproduce\nfi'
  )
})

it('retains ancestry while fetching a missing pinned blob for a detached worktree', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mobile-pin-checkout-'))
  const source = join(directory, 'source')
  const checkout = join(directory, 'checkout')
  const pinnedTree = join(directory, 'pinned-tree')
  const git = (cwd, ...args) => {
    const result = runProcessSync({ program: 'git', args, cwd })
    expect(result.code, result.stderr).toBe(0)
    return result.stdout.trim()
  }
  try {
    git(directory, 'init', '--quiet', source)
    git(source, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    git(source, 'config', 'user.name', 'Pin checkout fixture')
    git(source, 'config', 'user.email', 'pin-checkout@example.invalid')
    git(source, 'config', 'uploadpack.allowFilter', 'true')
    git(source, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
    const corpus = 'mobile/rpc-foundation/goldens/fixture.json'
    mkdirSync(join(source, 'mobile/rpc-foundation/goldens'), { recursive: true })
    const original = '{"baseline":"original historical recording"}\n'
    const commit = () => {
      git(source, 'add', '-A')
      git(source, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'recording')
      return git(source, 'rev-parse', 'HEAD')
    }
    writeFileSync(join(source, corpus), original)
    const baseline = commit()
    const oldBlob = git(source, 'rev-parse', `${baseline}:${corpus}`)
    writeFileSync(join(source, corpus), '{"baseline":"current recording"}\n')
    commit()
    git(
      directory,
      'clone',
      '--filter=blob:none',
      '--no-checkout',
      '--single-branch',
      '--no-tags',
      pathToFileURL(source).href,
      checkout
    )
    git(checkout, 'checkout', '--quiet', '--force', 'main')

    expect(git(checkout, 'rev-parse', '--is-shallow-repository')).toBe('false')
    expect(git(checkout, 'rev-list', '--count', 'HEAD')).toBe('2')
    git(checkout, 'merge-base', '--is-ancestor', baseline, 'HEAD')
    expect(git(checkout, 'rev-list', '--objects', '--missing=print', 'HEAD')).toContain(
      `?${oldBlob}`
    )

    git(checkout, 'worktree', 'add', '--detach', pinnedTree, baseline)

    expect(readFileSync(join(pinnedTree, corpus), 'utf8')).toBe(original)
    expect(git(checkout, 'rev-list', '--objects', '--missing=print', 'HEAD')).not.toContain(
      `?${oldBlob}`
    )
    git(checkout, 'worktree', 'remove', '--force', pinnedTree)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
