import { defineMethod } from '../../core'
import { normalizeColorQueryReplyColors } from '../../../../../shared/terminal/pty/ingress/pty-owner-color-query-colors'
import {
  setPairedViewAttributes,
  setPairedViewerColors
} from '../../../terminal/view/terminal-view-attribute-store'
import { validateTerminalViewAttributes } from '../../../../../shared/terminal/protocol/queries/terminal-view-attributes'
import { TerminalSetViewerColors } from '../../../../../shared/rpc-contract/terminal-unary-params'

export const TERMINAL_VIEWER_COLORS_METHODS = [
  defineMethod({
    name: 'terminal.setViewerColors',
    permission: 'workspace',
    params: TerminalSetViewerColors,
    // The host-wide default for PTYs no paired client launched: headless hosts take the last pusher's, windowed hosts keep their own.
    handler: async (params) => {
      const colors = normalizeColorQueryReplyColors(params.colors)
      const attributes = colors ? validateTerminalViewAttributes(params.attributes) : null
      if (colors) {
        setPairedViewerColors(colors)
      }
      if (attributes) {
        setPairedViewAttributes(attributes)
      }
      return { applied: colors !== null }
    }
  })
]
