import type { RuntimeTerminalPresentation } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'

export function createTerminalRevealWarning(handle: string, error?: unknown): string {
  const reason =
    error instanceof Error && error.message.trim().length > 0
      ? ` Reason: ${error.message.trim()}.`
      : ''
  const status =
    error === undefined
      ? 'no Orca window was available to focus it.'
      : `Orca could not make it discoverable.${reason}`
  return [
    `Terminal ${handle} is running, but ${status}`,
    `Run \`orca terminal focus --terminal ${handle}\` to reveal and focus it.`
  ].join(' ')
}

// Absence means default; surfacing callers must omit surfaceOwner instead of sending true.
export function ownerSurfacing(shouldSurface: boolean): { surfaceOwner?: false } {
  return shouldSurface ? {} : { surfaceOwner: false }
}

export function resolveTerminalPresentation(opts: {
  presentation?: RuntimeTerminalPresentation
  focus?: boolean
  activate?: boolean
}): RuntimeTerminalPresentation | undefined {
  if (opts.presentation) {
    return opts.presentation
  }
  if (opts.focus === true || opts.activate === true) {
    return 'focused'
  }
  return undefined
}
