import { stripClaudePinnedLaunchMarker } from '../../../../shared/claude/claude-pinned-launch-error'
import { formatTerminalStartFailure } from '../../../../shared/terminal/pty/lifecycle/terminal-start-failure'
import { readableWslDistroHoldText } from '../../../../shared/remote-runtime/wsl-hosts/wsl-distro-stopped-hold'

export function appendWorktreeTerminalFailure(
  warning: string | undefined,
  path: string,
  kind: 'startup' | 'initial',
  error: unknown
): string {
  const message = readableWslDistroHoldText(
    stripClaudePinnedLaunchMarker(
      formatTerminalStartFailure(error) ?? (error instanceof Error ? error.message : String(error))
    )
  )
  const failure = `failed to create the ${kind} terminal for ${path}: ${message}`
  const combined = warning
    ? `${warning} Also ${failure}`
    : `${failure[0].toUpperCase()}${failure.slice(1)}`
  console.warn(`[worktree-create] ${combined}`)
  return combined
}
