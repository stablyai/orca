import { HOST_ROUTE_NOTICES } from '../host-route-notice'
import { formatAgentTypeLabel } from '../../../src/shared/agent-type-label'
import type { StructuredSessionOpenFailure } from '../../../src/shared/open-structured-agent-session'
import { translate } from '../i18n/mobile-i18n'

export function mobileStructuredSessionOpenMessage(
  reason: StructuredSessionOpenFailure['reason'],
  displayLabel?: string,
  surface?: StructuredSessionOpenFailure['surface']
): string {
  if (reason === 'gone' && surface === 'terminal') {
    return translate(
      'session.structuredOpen.paneUnavailable',
      "Agent's pane is no longer available."
    )
  }
  if (reason === 'workspace-missing') {
    return HOST_ROUTE_NOTICES['worktree-missing']
  }
  if (!displayLabel || displayLabel === 'unknown') {
    switch (reason) {
      case 'gone':
        return translate(
          'session.structuredOpen.goneGeneric',
          "Agent's chat is no longer on this host, so it cannot be reopened here."
        )
      case 'unknown':
        return translate(
          'session.structuredOpen.unknownGeneric',
          "Agent's chat could not be found on this host. Reconnect to its computer and try again."
        )
      case 'unsupported':
        return translate(
          'session.structuredOpen.unsupportedGeneric',
          "Agent's chat can't be reopened until Orca is updated."
        )
      case 'unreachable':
        return translate(
          'session.structuredOpen.unreachableGeneric',
          "Agent's chat is not available yet. Retry in a moment."
        )
    }
  }
  const agent = formatAgentTypeLabel(displayLabel)
  switch (reason) {
    case 'gone':
      return translate(
        'session.structuredOpen.gone',
        "{{agent}}'s chat is no longer on this host, so it cannot be reopened here.",
        { agent }
      )
    case 'unknown':
      return translate(
        'session.structuredOpen.unknown',
        "{{agent}}'s chat could not be found on this host. Reconnect to its computer and try again.",
        { agent }
      )
    case 'unsupported':
      return translate(
        'session.structuredOpen.unsupported',
        "{{agent}}'s chat can't be reopened until Orca is updated.",
        { agent }
      )
    case 'unreachable':
      return translate(
        'session.structuredOpen.unreachable',
        "{{agent}}'s chat is not available yet. Retry in a moment.",
        { agent }
      )
  }
}
