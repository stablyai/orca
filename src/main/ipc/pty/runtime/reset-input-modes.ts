import { getLocalPtyBackendId } from '../../../../shared/terminal/pty/lifecycle/pty-backend-id'
import { getProviderForPty } from '../provider/registry'
import type { PtyRuntimeControllerDeps } from './controller-deps'

export async function resetInputModesFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string
): Promise<void> {
  if (getLocalPtyBackendId(ptyId) === 'rex') {
    throw new Error('Rex input mode reset unsupported')
  }
  // Remote reset must also ground this host window's pane.
  if (deps.mainWindow && !deps.mainWindow.isDestroyed()) {
    deps.mainWindow.webContents.send('pty:resetInputModes:request', { ptyId })
  }
  try {
    await getProviderForPty(ptyId).resetInputModes(ptyId)
  } catch {
    /* best effort: an older daemon or relay rejects the request */
  }
}
