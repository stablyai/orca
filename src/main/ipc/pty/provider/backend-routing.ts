import { getLocalPtyBackendId } from '../../../../shared/terminal/pty/lifecycle/pty-backend-id'

/** No fallback for a saved Rex binding. Until native registration, fail closed. */
export function selectLocalPtyBackend<T>(ptyId: string | undefined, standard: T, rex?: T): T {
  if (getLocalPtyBackendId(ptyId) === 'default') {
    return standard
  }
  if (!rex) {
    throw new Error('Rex PTY backend unavailable; saved session was not replaced')
  }
  return rex
}
