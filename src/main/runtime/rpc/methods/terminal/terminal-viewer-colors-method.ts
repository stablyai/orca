import { defineMethod } from '../../core'
import { normalizeColorQueryReplyColors } from '../../../../../shared/pty-owner-color-query-colors'
import { setPairedViewerColors } from '../../../terminal-view-attribute-store'
import { TerminalSetViewerColors } from '../../../../../shared/rpc-contract/terminal-unary-params'

export const TERMINAL_VIEWER_COLORS_METHODS = [
  defineMethod({
    name: 'terminal.setViewerColors',
    permission: 'workspace',
    params: TerminalSetViewerColors,
    // Headless hosts answer OSC 10/11 with the last paired viewer's colors; windowed hosts retain their own.
    handler: async (params) => {
      const colors = normalizeColorQueryReplyColors(params.colors)
      if (colors) {
        setPairedViewerColors(colors)
      }
      return { applied: colors !== null }
    }
  })
]
