import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gitExecFileSync } from '../../../git/runner'
import type { ControlPlaneStore } from './control-plane-store'

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

/** Records the successful gate process the completion contract now demands.
 *  Mirrors what `runGate` writes, without spawning a process per fixture. */
export function recordProvenGate(
  store: ControlPlaneStore,
  args: { scopeKey: string; gateId: string; finalSha: string }
): void {
  store.recordGateExecution({
    execution_id: `${args.scopeKey}#${args.gateId}#${args.finalSha}`,
    scope_key: args.scopeKey,
    gate_id: args.gateId,
    final_sha: args.finalSha,
    command: args.gateId,
    exit_code: 0,
    log_digest: 'fixture',
    build_id: 'fixture-build',
    started_at: '2026-01-01T00:00:00.000Z',
    finished_at: '2026-01-01T00:00:01.000Z'
  })
}
