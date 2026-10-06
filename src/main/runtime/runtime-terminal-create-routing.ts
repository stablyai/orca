import { resolveTerminalPresentation } from './orca-runtime-core'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'

export function resolveTerminalCreateRouting<TWindow>(
  worktreeSelector: string | undefined,
  opts: TerminalCreateOptions,
  availableWindow: TWindow | null
) {
  const requiresRendererFocus = opts.presentation === 'focused' || opts.focus === true
  return {
    presentation: resolveTerminalPresentation(opts),
    rendererWindow: opts.rendererBacked === true ? availableWindow : null,
    shouldCreateInBackground:
      worktreeSelector !== undefined &&
      (Boolean(opts.agentSessionClaim) ||
        opts.codexAccountId !== undefined ||
        (!requiresRendererFocus && opts.rendererBacked !== true) ||
        availableWindow === null)
  }
}
