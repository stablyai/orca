import type { BrowserWindow } from 'electron'
import type { AgentSessionPtyWriteRefusal } from '../../../shared/agent-session-pty-write-admission'

// Why: a lease refusal is never a silent drop — it rides the existing write-unavailable channel
// with an additive field, so old renderers keep their current behavior and new ones can name the
// owner. See docs/reference/remote-wire-compatibility.md.
export function reportAgentSessionWriteRefusal(
  mainWindow: BrowserWindow,
  id: string,
  refusal: AgentSessionPtyWriteRefusal
): void {
  if (
    mainWindow.isDestroyed() ||
    (typeof mainWindow.webContents.isDestroyed === 'function' &&
      mainWindow.webContents.isDestroyed())
  ) {
    return
  }
  mainWindow.webContents.send('pty:writeUnavailable', { id, agentSessionRefusal: refusal })
}
