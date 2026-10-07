/**
 * Which activation fence this run holds, so every remote step it issues can prove it still does.
 *
 * Age only says a holder went quiet, not that it cannot act: a desktop suspended past the stale
 * window resumes believing it owns the fence a successor has since taken (Astra pass 8). Each
 * holder writes a generation token into the lock it creates, and each of its commands checks that
 * token on the host, in the same command as the step, so a superseded holder aborts instead of
 * launching, mutating state, or deleting the successor's fence and journal.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { shellEscape } from './ssh-connection-utils'
import { isSshCommandExitError } from './ssh-relay-exec-command'

export const ORCAD_FENCE_OWNER_FILENAME = '.orca-fence-owner'
export const ORCAD_FENCE_LOST_MARKER = '__ORCAD_FENCE_LOST__'
/** EX_TEMPFAIL: the step did not run, and retrying under this fence never will. */
export const ORCAD_FENCE_LOST_EXIT = 75

export type OrcadFence = { lockDir: string; token: string }

const scope = new AsyncLocalStorage<OrcadFence>()

export function runWithOrcadFence<T>(fence: OrcadFence, run: () => Promise<T>): Promise<T> {
  return scope.run(fence, run)
}

export function currentOrcadFence(): OrcadFence | null {
  return scope.getStore() ?? null
}

export class OrcadFenceLostError extends Error {
  constructor() {
    super(
      "This run's activation fence was taken over by another run, so it stopped before changing the host."
    )
    this.name = 'OrcadFenceLostError'
  }
}

/** A POSIX test that succeeds only while the lock still carries this run's token. */
export function posixOrcadFenceOwnedTest(fence: OrcadFence): string {
  const owner = shellEscape(`${fence.lockDir.replace(/\/+$/u, '')}/${ORCAD_FENCE_OWNER_FILENAME}`)
  return `[ "$(cat ${owner} 2>/dev/null)" = ${shellEscape(fence.token)} ]`
}

export function posixOrcadFenceGuard(fence: OrcadFence): string {
  return `${posixOrcadFenceOwnedTest(fence)} || { echo ${ORCAD_FENCE_LOST_MARKER}; exit ${ORCAD_FENCE_LOST_EXIT}; };`
}

/**
 * Classified from the exit status and the step's own stdout, never the message: the message
 * quotes the command, and every fenced command carries the guard's marker text.
 */
export function isOrcadFenceLost(error: unknown): boolean {
  if (!isSshCommandExitError(error)) {
    return false
  }
  // `powershell -Command` reports any nonzero native exit as 1.
  const exited = error.exitCode === ORCAD_FENCE_LOST_EXIT || error.exitCode === 1
  return exited && error.stdout.trim().split(/\r?\n/u).at(-1) === ORCAD_FENCE_LOST_MARKER
}
