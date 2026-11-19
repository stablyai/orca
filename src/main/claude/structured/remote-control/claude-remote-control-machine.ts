import type { AgentSessionProviderRemoteControl } from '../../../../shared/agent-session/remote-control/agent-session-provider-remote-control'

// One Claude child's Remote Control link. Requests carry the generation that sent them, so a late
// answer to a request the person has since reversed cannot bring the link back.

type Link = {
  generation: number
  enabledByDefault: boolean
  sessionUrl?: string
}

export type ClaudeRemoteControlPhase =
  | { kind: 'off'; generation: number }
  /** `remote_control` sent; Claude has not answered. */
  | ({ kind: 'requesting' } & Link)
  /** Claude registered the session; the link to claude.ai is not up yet. */
  | ({ kind: 'connecting' } & Link)
  | ({ kind: 'connected' } & Link)
  | ({ kind: 'failed'; detail?: string } & Link)
  /** Managed settings or the organization turned Remote Control off. */
  | { kind: 'policy-disabled'; generation: number; detail?: string }
  /** `remote_control` with enabled:false sent; Claude has not answered. `link` returns if it refuses. */
  | { kind: 'disconnecting'; generation: number; link: LinkPhase }

type LinkPhase = Extract<
  ClaudeRemoteControlPhase,
  { kind: 'requesting' | 'connecting' | 'connected' | 'failed' }
>

export type ClaudeRemoteControlEvent =
  | { type: 'connect'; enabledByDefault: boolean }
  | { type: 'disconnect' }
  | { type: 'answered'; generation: number; sessionUrl?: string }
  | { type: 'refused'; generation: number; detail: string }
  | { type: 'disconnected'; generation: number }
  /** Claude refused or never answered a disable, so its link may still be up. */
  | { type: 'disconnect-refused'; generation: number }
  /** A `system`/`bridge_state` frame; its state is Claude's word, unknown words change nothing. */
  | { type: 'bridge'; state: string; detail?: string }
  | { type: 'exited' }

export type ClaudeRemoteControlEffect =
  | { kind: 'enable'; generation: number }
  | { kind: 'disable'; generation: number }

export type ClaudeRemoteControlTransition = {
  phase: ClaudeRemoteControlPhase
  effect?: ClaudeRemoteControlEffect
}

export const CLAUDE_REMOTE_CONTROL_OFF: ClaudeRemoteControlPhase = { kind: 'off', generation: 0 }

export function advanceClaudeRemoteControl(
  phase: ClaudeRemoteControlPhase,
  event: ClaudeRemoteControlEvent
): ClaudeRemoteControlTransition {
  switch (event.type) {
    case 'connect': {
      if (
        phase.kind === 'requesting' ||
        phase.kind === 'connecting' ||
        phase.kind === 'connected'
      ) {
        return { phase }
      }
      const generation = phase.generation + 1
      return {
        phase: { kind: 'requesting', generation, enabledByDefault: event.enabledByDefault },
        effect: { kind: 'enable', generation }
      }
    }
    case 'disconnect': {
      if (phase.kind === 'off' || phase.kind === 'disconnecting') {
        return { phase }
      }
      if (phase.kind === 'policy-disabled') {
        return { phase: { kind: 'off', generation: phase.generation } }
      }
      const generation = phase.generation + 1
      // The pending connect's answer is stale from here, so a restored link waits on the bridge.
      const link: LinkPhase = {
        ...phase,
        kind: phase.kind === 'requesting' ? 'connecting' : phase.kind
      }
      return {
        phase: { kind: 'disconnecting', generation, link },
        effect: { kind: 'disable', generation }
      }
    }
    case 'answered':
      // A disable still pending keeps what Claude proves, in case it is refused.
      if (phase.kind === 'disconnecting' && phase.link.generation === event.generation) {
        return { phase: { ...phase, link: withAnswer(phase.link, event.sessionUrl) } }
      }
      return isLink(phase) && phase.generation === event.generation
        ? { phase: withAnswer(phase, event.sessionUrl) }
        : { phase }
    case 'refused':
      // A timeout after the bridge connected says nothing about the link Claude already proved.
      return isLink(phase) && phase.generation === event.generation && phase.kind !== 'connected'
        ? { phase: { ...phase, kind: 'failed', detail: event.detail } }
        : { phase }
    case 'disconnected':
      return phase.kind === 'disconnecting' && phase.generation === event.generation
        ? { phase: { kind: 'off', generation: phase.generation } }
        : { phase }
    case 'disconnect-refused':
      return phase.kind === 'disconnecting' && phase.generation === event.generation
        ? { phase: { ...phase.link, generation: phase.generation } }
        : { phase }
    case 'bridge':
      return { phase: advanceOnBridge(phase, event.state, event.detail) }
    case 'exited':
      return { phase: { kind: 'off', generation: phase.generation } }
  }
}

function withAnswer(link: LinkPhase, sessionUrl: string | undefined): LinkPhase {
  return {
    ...link,
    // A bridge frame can beat the answer; the answer never moves a link backwards.
    kind: link.kind === 'requesting' ? 'connecting' : link.kind,
    ...(sessionUrl ? { sessionUrl } : {})
  }
}

function advanceOnBridge(
  phase: ClaudeRemoteControlPhase,
  state: string,
  detail: string | undefined
): ClaudeRemoteControlPhase {
  if (phase.kind === 'disconnecting') {
    const link = advanceOnBridge(phase.link, state, detail)
    return isLink(link) ? { ...phase, link } : phase
  }
  if (phase.kind === 'off') {
    return phase
  }
  if (state === 'policy_disabled') {
    return {
      kind: 'policy-disabled',
      generation: phase.generation,
      ...(detail ? { detail } : {})
    }
  }
  if (!isLink(phase)) {
    return phase
  }
  const link = linkFields(phase)
  switch (state) {
    case 'ready':
      return { ...link, kind: 'connecting' }
    case 'connected':
      return { ...link, kind: 'connected' }
    case 'failed':
      return { ...link, kind: 'failed', ...(detail ? { detail } : {}) }
    default:
      return phase
  }
}

function linkFields(phase: Link): Link {
  return {
    generation: phase.generation,
    enabledByDefault: phase.enabledByDefault,
    ...(phase.sessionUrl ? { sessionUrl: phase.sessionUrl } : {})
  }
}

function isLink(phase: ClaudeRemoteControlPhase): phase is LinkPhase {
  return (
    phase.kind === 'requesting' ||
    phase.kind === 'connecting' ||
    phase.kind === 'connected' ||
    phase.kind === 'failed'
  )
}

/** What clients see; a link being torn down already reads as off. */
export function claudeRemoteControlView(
  phase: ClaudeRemoteControlPhase
): AgentSessionProviderRemoteControl | undefined {
  if (phase.kind === 'off' || phase.kind === 'disconnecting') {
    return undefined
  }
  if (phase.kind === 'policy-disabled') {
    return { state: 'policy-disabled', ...(phase.detail ? { detail: phase.detail } : {}) }
  }
  return {
    state:
      phase.kind === 'connected' ? 'connected' : phase.kind === 'failed' ? 'failed' : 'connecting',
    ...(phase.sessionUrl ? { sessionUrl: phase.sessionUrl } : {}),
    ...(phase.kind === 'failed' && phase.detail ? { detail: phase.detail } : {}),
    ...(phase.enabledByDefault ? { enabledByDefault: true as const } : {})
  }
}
