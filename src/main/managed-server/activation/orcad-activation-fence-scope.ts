// Resumed stale holders must prove their generation on-host before every step, preventing writes or release under a successor's fence.
import { AsyncLocalStorage } from 'node:async_hooks'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { isSshCommandExitError } from '../../ssh/remote-exec/remote-exec-command'

export const ORCAD_FENCE_OWNER_FILENAME = '.orca-fence-owner'
export const ORCAD_FENCE_LOST_MARKER = '__ORCAD_FENCE_LOST__'
/** EX_TEMPFAIL: this superseded generation cannot retry its step. */
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

export function posixOrcadFenceOwnedTest(fence: OrcadFence): string {
  const owner = quotePosixShell(
    `${fence.lockDir.replace(/\/+$/u, '')}/${ORCAD_FENCE_OWNER_FILENAME}`
  )
  return `[ "$(cat ${owner} 2>/dev/null)" = ${quotePosixShell(fence.token)} ]`
}

export function posixOrcadFenceGuard(fence: OrcadFence): string {
  return `${posixOrcadFenceOwnedTest(fence)} || { echo ${ORCAD_FENCE_LOST_MARKER}; exit ${ORCAD_FENCE_LOST_EXIT}; };`
}

/** Use exit status and stdout; error messages quote commands containing the marker even when no guard failed. */
export function isOrcadFenceLost(error: unknown): boolean {
  if (!isSshCommandExitError(error)) {
    return false
  }
  // `powershell -Command` reports any nonzero native exit as 1.
  const exited = error.exitCode === ORCAD_FENCE_LOST_EXIT || error.exitCode === 1
  return exited && error.stdout.trim().split(/\r?\n/u).at(-1) === ORCAD_FENCE_LOST_MARKER
}
