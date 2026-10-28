import { getPtyIpc } from '../pty-host-bindings'
import {
  getTerminalViewerColors,
  seedTerminalViewerColors,
  setTerminalViewAttributes,
  setTerminalViewerColorsListener
} from '../../../runtime/terminal-view-attribute-store'
import { validateTerminalViewAttributes } from '../../../../shared/terminal-view-attributes'
import { resolveConfiguredTerminalColors } from '../../../../shared/terminal-theme-selection'
import { publishColorQueryReplyColors } from '../provider/registry'
import type { PtyIpcSession } from '../session'

export function installTerminalViewAttributesIpc(
  session: Pick<PtyIpcSession, 'getSettings' | 'options'>
): void {
  setTerminalViewerColorsListener(publishColorQueryReplyColors)
  const settings = session.getSettings?.()
  // Answer with saved theme before any viewer push, including headless hosts that may never get one.
  if (settings) {
    seedTerminalViewerColors(
      resolveConfiguredTerminalColors(settings, session.options?.systemPrefersDark?.() ?? true)
    )
  }
  const current = getTerminalViewerColors()
  if (current) {
    publishColorQueryReplyColors(current)
  }
  const ipcMain = getPtyIpc()
  ipcMain.removeAllListeners('pty:terminalViewAttributes')
  ipcMain.on('pty:terminalViewAttributes', (_event, args: unknown) => {
    // Malformed palettes would give TUIs incorrect color replies.
    const attributes = validateTerminalViewAttributes(args)
    if (attributes) {
      setTerminalViewAttributes(attributes)
    }
  })
}
