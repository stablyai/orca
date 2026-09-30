import type { SshTarget } from '../../shared/ssh-types'
import type { SshResolvedConfig } from './ssh-config-parser'
import { expandAgentSocketEnv, resolveAgentSocket } from './ssh-auth-resolution'
import { isOpenSshConfigBackedTarget } from './ssh-config-backed-target'

export type AgentForwardingDisabledReason =
  | 'not-requested'
  | 'config-unresolved'
  | 'no-agent-socket'

export type AgentForwardingIntent =
  | { enabled: false; reason: AgentForwardingDisabledReason }
  | { enabled: true; socket: string; socketSource: 'forward-agent-path' | 'identity-agent' }

type ForwardingTarget = Pick<
  SshTarget,
  'identityAgent' | 'configHost' | 'source' | 'host' | 'forwardAgent'
>
type ForwardingResolvedConfig = Pick<
  SshResolvedConfig,
  'forwardAgent' | 'forwardAgentSocket' | 'identityAgent'
>

/**
 * Which local agent socket, if any, OpenSSH would forward for this target.
 *
 * Deliberately independent of how authentication goes: `IdentitiesOnly` and a failed agent login
 * narrow what is offered to the server, never what is forwarded (ssh_config(5), ForwardAgent).
 */
export function resolveAgentForwardingIntent(
  target: ForwardingTarget,
  resolved: ForwardingResolvedConfig | null
): AgentForwardingIntent {
  // Same precedence as IdentityAgent (resolveAgentSocket): fresh ssh -G wins for config-backed
  // targets, an explicit per-target choice wins for manual ones.
  const fromTarget = isOpenSshConfigBackedTarget(target)
    ? !resolved && target.forwardAgent !== undefined
    : target.forwardAgent !== undefined
  if (fromTarget) {
    return target.forwardAgent
      ? identityAgentIntent(target, resolved)
      : { enabled: false, reason: 'not-requested' }
  }
  if (!resolved) {
    return { enabled: false, reason: 'config-unresolved' }
  }
  if (!resolved.forwardAgent) {
    return { enabled: false, reason: 'not-requested' }
  }
  if (resolved.forwardAgentSocket) {
    const socket = expandAgentSocketEnv(resolved.forwardAgentSocket)
    return socket
      ? { enabled: true, socket, socketSource: 'forward-agent-path' }
      : { enabled: false, reason: 'no-agent-socket' }
  }
  return identityAgentIntent(target, resolved)
}

/** Log-safe summary: reasons and socket kinds only, never the socket path. */
export function describeAgentForwardingIntent(intent: AgentForwardingIntent): string {
  return intent.enabled ? `requested (${intent.socketSource})` : `off (${intent.reason})`
}

// Why IdentityAgent and not only SSH_AUTH_SOCK: ssh exports IdentityAgent as its own
// SSH_AUTH_SOCK before forwarding, so `IdentityAgent none` also disables `ForwardAgent yes`.
function identityAgentIntent(
  target: ForwardingTarget,
  resolved: ForwardingResolvedConfig | null
): AgentForwardingIntent {
  const socket = resolveAgentSocket(target, resolved)
  return socket
    ? { enabled: true, socket, socketSource: 'identity-agent' }
    : { enabled: false, reason: 'no-agent-socket' }
}
