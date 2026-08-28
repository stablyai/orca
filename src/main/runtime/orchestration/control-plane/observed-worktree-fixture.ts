import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gitExecFileSync } from '../../../git/runner'
import type { ControlPlaneStore } from './control-plane-store'
import { runGate } from './runtime-gate-execution'
import { requiredGateSpecRow } from './required-gate-spec'
import { fingerprintGateDependencies } from './gate-dependency-fingerprint'

/** A real Git worktree for tests of the runtime-observed completion contract.
 *
 *  Why real: `observeCompletion` runs `git rev-parse`/`git status` itself, so a
 *  fixture that stubbed them would test the stub, not the guard that exists to
 *  stop a worker describing a tree nobody looked at.
 */

export type ObservedWorktreeFixture = {
  path: string
  /** The `<repoId>::<absolutePath>` form Dispatch rows carry. */
  worktreeId: string
  /** Real HEAD, so a claim naming it is one the runtime can confirm. */
  headSha: string
  /** Commits a new file and returns the new HEAD, updating `headSha` with it. */
  commit(name: string): string
  /** Leaves an untracked file behind so `git status` reports the tree dirty. */
  dirty(): void
  cleanup(): void
}

export function createObservedWorktree(repoId = 'repo_test'): ObservedWorktreeFixture {
  const path = mkdtempSync(join(tmpdir(), 'orca-observed-'))
  const git = (args: string[]): string => gitExecFileSync(args, { cwd: path })
  git(['init', '--quiet'])
  git(['config', 'user.email', 'fixture@orca.test'])
  git(['config', 'user.name', 'Fixture'])
  writeFileSync(join(path, 'a.txt'), 'one\n')
  git(['add', 'a.txt'])
  git(['commit', '--quiet', '-m', 'fixture'])
  const fixture: ObservedWorktreeFixture = {
    path,
    worktreeId: `${repoId}::${path}`,
    headSha: git(['rev-parse', 'HEAD']).trim(),
    commit: (name: string) => {
      mkdirSync(dirname(join(path, name)), { recursive: true })
      writeFileSync(join(path, name), `${name}\n`)
      git(['add', name])
      git(['commit', '--quiet', '-m', name])
      fixture.headSha = git(['rev-parse', 'HEAD']).trim()
      return fixture.headSha
    },
    dirty: () => writeFileSync(join(path, 'dirty.txt'), 'uncommitted\n'),
    cleanup: () => rmSync(path, { recursive: true, force: true })
  }
  return fixture
}

/** Records the successful gate the completion contract demands, by actually
 *  RUNNING one.
 *
 *  Why a real process and not a hand-written row: an independent review found
 *  that `runGate` had no production caller, so every accepted-completion test
 *  was passing on a row the fixture wrote itself — proving the guard while
 *  concealing that its satisfiable side did not exist. Going through `runGate`
 *  means these tests fail if the execution path breaks, not merely if someone
 *  stops writing the row. `cwd` is the tree the Dispatch actually ran in. */
export function recordProvenGate(
  store: ControlPlaneStore,
  args: {
    scopeKey: string
    gateId: string
    finalSha: string
    cwd?: string
    dispatchId?: string
    worktreeId?: string
    buildId?: string
    policyVersion?: string
    commandIdentity?: string
    dependencies?: readonly string[]
    shaBinding?: 'content' | 'exact_head'
  }
): void {
  const [runId, outcomeId] = args.scopeKey.split(':') as [string, string]
  const cwd = args.cwd ?? tmpdir()
  const policyVersion = args.policyVersion ?? 'v1'
  const commandIdentity = args.commandIdentity ?? args.gateId
  const dependencies = args.dependencies ?? ['a.txt']
  const shaBinding = args.shaBinding ?? 'exact_head'
  const spec = requiredGateSpecRow(outcomeId, {
    gateId: args.gateId,
    program: 'git',
    args: ['--version'],
    dependencies,
    policyVersion,
    commandIdentity,
    shaBinding
  })
  if (!store.getRequiredGateSpec(outcomeId, args.gateId)) {
    store.insertRequiredGateSpec(spec)
  }
  const result = runGate(store, {
    scopeKey: args.scopeKey,
    gateId: args.gateId,
    finalSha: args.finalSha,
    // A command every supported platform has, whose only job is to exit zero.
    program: 'git',
    args: ['--version'],
    cwd,
    buildId: args.buildId ?? 'fixture-build',
    runId,
    outcomeId,
    dispatchId: args.dispatchId ?? 'fixture-dispatch',
    worktreeId: args.worktreeId ?? `fixture::${cwd}`,
    policyVersion,
    commandIdentity,
    specHash: spec.spec_hash,
    inputHashes: fingerprintGateDependencies({
      spec: { gateId: args.gateId, files: dependencies },
      fallbackFiles: [],
      cwd,
      policyVersion,
      commandIdentity,
      program: spec.program
    }),
    shaBinding
  })
  if (!result.passed) {
    throw new Error(`Fixture gate did not pass: exit ${result.execution.exit_code}`)
  }
}
