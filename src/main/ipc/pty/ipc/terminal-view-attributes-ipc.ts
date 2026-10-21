import { getPtyIpc } from '../../pty-host-bindings'
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
  // Why seed from settings: a headless host may never hear from a viewer, and a desktop pane
  // can query before the first push lands; either way the owner should answer with the saved theme.
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
    // Why validate-or-drop: a malformed palette would give TUIs a wrong color reply.
    const attributes = validateTerminalViewAttributes(args)
    if (attributes) {
      setTerminalViewAttributes(attributes)
    }
  })
}
