import { getAppEnvironment } from '../../../../shared/app-environment'
import { TerminalDraftCoordinator } from './terminal-draft-coordinator'

let coordinator: TerminalDraftCoordinator | null = null

export function getTerminalDraftCoordinator(): TerminalDraftCoordinator {
  coordinator ??= new TerminalDraftCoordinator(getAppEnvironment().getPath('userData'))
  return coordinator
}

/** PTY teardown drops its lease, epochs and replay answers; a reused id starts clean. */
export function disposeTerminalDraftState(ptyId: string): void {
  coordinator?.dispose(ptyId)
}
