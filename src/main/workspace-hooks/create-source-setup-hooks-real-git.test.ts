import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repository/repo-types'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import { RuntimeRemoteFetchController } from '../runtime/repositories/runtime-remote-fetch-controller'
import { readCreateSourceSetupHooks } from './create-source-setup-hooks'

const roots: string[] = []
beforeEach(() => {
  // Base-branch reads fetch, which is network-classed, so every fetch first probes
  // core.sshCommand with a 2.5s budget that flakes under parallel-test spawn load.
  // Local-path remotes never invoke SSH, so short-circuiting that probe is
  // behavior-preserving here.
  vi.stubEnv('GIT_SSH_COMMAND', 'ssh')
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const commitArgs = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com']

async function git(cwd: string, ...args: string[]): Promise<void> {
  await gitExecFileAsync(args, { cwd })
}

async function commitOrcaYaml(cwd: string, setupLine: string, eol = '\n'): Promise<void> {
  const yaml = ['scripts:', '  setup: |', `    ${setupLine}`, ''].join(eol)
  await writeFile(join(cwd, 'orca.yaml'), yaml)
  await git(cwd, 'add', 'orca.yaml')
  await git(cwd, ...commitArgs, 'commit', '-m', setupLine)
}

// A project checkout left on old setup commands while origin/main moved on.
async function staleCheckout(): Promise<{ repo: Repo; upstream: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-create-source-hooks-'))
  roots.push(root)
  const upstream = join(root, 'upstream')
  const checkout = join(root, 'checkout')
  await git(root, 'init', '-b', 'main', upstream)
  await git(upstream, 'config', 'core.autocrlf', 'false')
  await commitOrcaYaml(upstream, 'node old-setup.mjs')
  await git(root, 'clone', upstream, checkout)
  await commitOrcaYaml(upstream, 'node new-setup.mjs', '\r\n')
  const repo: Repo = {
    id: 'repo-1',
    path: checkout,
    displayName: 'repo',
    badgeColor: '#000000',
    addedAt: 0
  }
  return { repo, upstream }
}

function read(repo: Repo, source: Parameters<typeof readCreateSourceSetupHooks>[0]['source']) {
  return readCreateSourceSetupHooks({
    repo,
    source,
    runtime: new RuntimeRemoteFetchController(),
    gitOptions: {}
  })
}

// Cold node:child_process spawns inside a Bun worker thread cost seconds each; real-git fetch tests pay for all of them.
it('reads the refreshed base instead of the stale project checkout', async () => {
  const { repo } = await staleCheckout()

  // The 8s create-source read deadline can lose to cold git spawns under parallel-test load; this
  // fixture guarantees a defined answer, so retry the whole read (each attempt gets a fresh deadline).
  await vi.waitFor(async () => {
    const result = await read(repo, { kind: 'base', baseBranch: 'origin/main' })
    expect(result?.hooks?.scripts.setup).toBe('node new-setup.mjs')
  }, 90_000)
}, 90_000)

// Cold node:child_process spawns inside a Bun worker thread cost seconds each; real-git fetch tests pay for all of them.
it('reads an explicitly reused local branch, and the base when that branch is absent', async () => {
  const { repo } = await staleCheckout()
  await git(repo.path, 'branch', 'feature', 'main')

  const reused = await read(repo, { kind: 'branch', ref: 'feature', baseBranch: 'origin/main' })
  const created = await read(repo, { kind: 'branch', ref: 'missing', baseBranch: 'origin/main' })

  expect(reused?.hooks?.scripts.setup).toBe('node old-setup.mjs')
  expect(created?.hooks?.scripts.setup).toBe('node new-setup.mjs')
}, 90_000)
