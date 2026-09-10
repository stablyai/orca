/**
 * Proving, on the execution host, that a skill-install destination really is a
 * workspace checkout.
 *
 * The SSH relay's `authority()` used to hand the caller's own `workspace.path`
 * straight back as the destination root, so a request could name any directory
 * on the host and have a packaged skill tree written there (#18273, threat
 * model TM-04/TM-11). The relay has no worktree catalog to look the id up in —
 * an Orca worktree id is client metadata — so the host's own answer has to come
 * from Git: `rev-parse --show-toplevel` inside the candidate names the working
 * tree that directory belongs to, and only a real checkout root answers with
 * itself. `~/.ssh`, `~/.gnupg` and `/etc` do not.
 */

import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runProcess } from '../shared/child-process/run-process'

const GIT_PROOF_TIMEOUT_MS = 10_000

/**
 * Whether `candidatePath` is the root of a Git working tree on this host.
 *
 * `--show-toplevel` is Git 1.7-era, so no capability probe is needed. A missing
 * Git, a non-repository, or a path merely *inside* a checkout all answer false;
 * the caller then reports the workspace as not found.
 */
export async function isHostGitWorktreeRoot(candidatePath: string): Promise<boolean> {
  const result = await runProcess({
    program: 'git',
    args: ['-C', candidatePath, 'rev-parse', '--show-toplevel'],
    timeoutMs: GIT_PROOF_TIMEOUT_MS
  }).catch(() => null)
  const reported = result?.code === 0 ? result.stdout.trim() : ''
  if (!reported) {
    return false
  }
  // Why realpath both sides: Git reports the resolved tree, while the request
  // may name a symlinked or `/private`-prefixed spelling of the same directory.
  const [candidate, toplevel] = await Promise.all([
    realpath(candidatePath).catch(() => resolve(candidatePath)),
    realpath(reported).catch(() => resolve(reported))
  ])
  return candidate === toplevel
}
