import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { parseAppWslPtyId } from '../../shared/wsl-pty-id'
import type { WslDaemonSessions } from './wsl-daemon-sessions'
import { wslHookRelayManager } from '../agent-hooks/wsl-hook-relay-manager'
import type { PtySpawnResult } from '../providers/types'

/** Return true for guest owners so callers never fall back to default-user hook preparation. */
export async function prepareWslDaemonReattachHooks(args: {
  result: Pick<PtySpawnResult, 'id' | 'isReattach'>
  sessions?: Pick<WslDaemonSessions, 'reconnect'>
  hooksEnabled: boolean
  selectedCodexHomePath?: string | null
}): Promise<boolean> {
  const owner = parseAppWslPtyId(args.result.id)
  if (!owner) {
    return false
  }
  if (!args.result.isReattach || !args.hooksEnabled) {
    return true
  }
  const sessions = args.sessions
  if (!sessions) {
    console.warn('[wsl] Terminal hooks unavailable: captured owner is not connected')
    return true
  }
  void waitForPromiseWithSignal(
    sessions.reconnect(owner).then(async ({ endpoint }) => {
      await wslHookRelayManager.ensureForDistro(
        endpoint.distro,
        args.selectedCodexHomePath,
        undefined,
        endpoint.userName
      )
    }),
    AbortSignal.timeout(15_000)
  ).catch((error) => console.warn('[wsl] Terminal reattach hooks unavailable', error))
  return true
}
