import type { PtyControllerTerminalIdentity } from './runtime-pty-controller-contract'
import type { PtyProcessInfo } from '../providers/types'

export function buildControllerTerminalIdentities(sessions: PtyProcessInfo[]): {
  controllerIdentityByPtyId: Map<string, PtyControllerTerminalIdentity>
  ptyIdByControllerHandle: Map<string, string>
} {
  const controllerIdentityByPtyId = new Map<string, PtyControllerTerminalIdentity>()
  const ptyIdByControllerHandle = new Map<string, string>()
  const ambiguousControllerPtyIds = new Set<string>()
  for (const session of sessions) {
    const handle = session.terminalHandle?.trim()
    const incarnationId = session.incarnationId?.trim()
    if (!handle?.startsWith('term_') || !incarnationId) {
      continue
    }
    const priorPtyId = ptyIdByControllerHandle.get(handle)
    if (priorPtyId && priorPtyId !== session.id) {
      ambiguousControllerPtyIds.add(priorPtyId)
      ambiguousControllerPtyIds.add(session.id)
      controllerIdentityByPtyId.delete(priorPtyId)
      continue
    }
    if (controllerIdentityByPtyId.has(session.id)) {
      ambiguousControllerPtyIds.add(session.id)
      controllerIdentityByPtyId.delete(session.id)
      continue
    }
    ptyIdByControllerHandle.set(handle, session.id)
    controllerIdentityByPtyId.set(session.id, {
      handle,
      incarnationId,
      ...(session.wslDistro !== undefined ? { wslDistro: session.wslDistro } : {})
    })
  }
  for (const ptyId of ambiguousControllerPtyIds) {
    controllerIdentityByPtyId.delete(ptyId)
  }
  return { controllerIdentityByPtyId, ptyIdByControllerHandle }
}
