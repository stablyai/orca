import type { TerminalCreateOptions } from '../../runtime-terminal-contracts'
import { admitPairedCreateColors } from '../../terminal-view-attribute-store'

export function admitTerminalCreate(
  worktreeSelector: string | undefined,
  opts: TerminalCreateOptions
) {
  if (opts.startupAgent && worktreeSelector === undefined) {
    throw new Error(`startupAgent ${opts.startupAgent} requires a workspace selector.`)
  }
  return admitPairedCreateColors(opts.terminalColorQueryReplies, opts.terminalViewAttributes)
}
