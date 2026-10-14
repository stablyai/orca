import type { OrchestrationCompatibilityTerminalAuthority } from './runtime-terminal-contracts'

export function orchestrationCompatibilityHostScopesEqual(
  left: OrchestrationCompatibilityTerminalAuthority['hostScope'],
  right: OrchestrationCompatibilityTerminalAuthority['hostScope']
): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  if (left.kind === 'local' && right.kind === 'local') {
    return left.hostId === right.hostId
  }
  if (left.kind === 'wsl' && right.kind === 'wsl') {
    return left.hostId === right.hostId && left.distro === right.distro
  }
  return left.kind === 'ssh' && right.kind === 'ssh' && left.targetId === right.targetId
}
