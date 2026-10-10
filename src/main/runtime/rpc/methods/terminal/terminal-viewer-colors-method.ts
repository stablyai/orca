import { defineMethod } from '../../core'
import { normalizeColorQueryReplyColors } from '../../../../../shared/pty-owner-color-query-colors'
import { setPairedViewerColors } from '../../../terminal-view-attribute-store'
import { TerminalSetViewerColors } from './unary-schemas'

export const TERMINAL_VIEWER_COLORS_METHODS = [
  defineMethod({
    name: 'terminal.setViewerColors',
    permission: 'workspace',
    params: TerminalSetViewerColors,
    // Why: a headless host has no theme of its own to answer OSC 10/11 with, so it answers with
    // the colours of the paired client that last pushed; a host with its own window keeps its own.
    handler: async (params) => {
      const colors = normalizeColorQueryReplyColors(params.colors)
      if (colors) {
        setPairedViewerColors(colors)
      }
      return { applied: colors !== null }
    }
  })
]
