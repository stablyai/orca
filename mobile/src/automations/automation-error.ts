import { translate } from '../i18n/mobile-i18n'
import { matchAutomationOwnerConflict } from '../../../src/shared/automation-owner-conflict'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'

export const AUTOMATION_OUTCOME_UNKNOWN =
  'The host may have applied this action. Refresh to check before trying again.'

export class AutomationDraftValidationError extends Error {
  constructor(readonly field: 'project' | 'workspace' | 'destination') {
    super(field)
  }
}

export function automationOutcomeUnknownMessage(): string {
  return translate(
    'automations.mobile.outcomeUnknown',
    'The host may have applied this action. Refresh to check before trying again.'
  )
}

export function automationErrorMessage(error: unknown): string {
  if (error instanceof AutomationDraftValidationError) {
    switch (error.field) {
      case 'project':
        return translate(
          'automations.mobile.chooseAProjectSetUpOnThisHost',
          'Choose a project set up on this host.'
        )
      case 'workspace':
        return translate(
          'automations.mobile.chooseAnExistingWorkspace',
          'Choose an existing workspace.'
        )
      case 'destination':
        return translate(
          'automations.mobile.invalidDestination',
          'That host is no longer available on this authority. Pick a host and try again.'
        )
    }
  }
  if (isRpcDeliveryUnknown(error)) {
    return automationOutcomeUnknownMessage()
  }
  const conflict = matchAutomationOwnerConflict(error)
  if (conflict) {
    switch (conflict) {
      case 'automation_owner_changed':
        return translate(
          'automations.mobile.ownerChanged',
          "This automation's host changed. Reload it before continuing."
        )
      case 'automation_target_removed':
        return translate(
          'automations.mobile.targetRemoved',
          "This automation's SSH host was removed, so it cannot run. Delete it or re-add that host."
        )
      case 'automation_owner_fencing_required':
        return translate(
          'automations.mobile.fencingRequired',
          'This automation is pinned to an SSH host, so the request must name the host it expects.'
        )
      case 'automation_destination_invalid':
        return translate(
          'automations.mobile.invalidDestination',
          'That host is no longer available on this authority. Pick a host and try again.'
        )
    }
  }
  const message = error instanceof Error ? error.message : ''
  if (message === AUTOMATION_OUTCOME_UNKNOWN) {
    return automationOutcomeUnknownMessage()
  }
  if (
    message ===
    'Agent discovery is unavailable for this project host. Saved agent choices are preserved.'
  ) {
    return translate(
      'automations.mobile.agentDiscoveryUnavailable',
      'Agent discovery is unavailable for this project host. Saved agent choices are preserved.'
    )
  }
  if (
    message === 'This host cannot verify agents for this project. Update the host and try again.'
  ) {
    return translate(
      'automations.mobile.agentVerificationUnavailable',
      'This host cannot verify agents for this project. Update the host and try again.'
    )
  }
  if (/forbidden|method_not_found/.test(message)) {
    return translate(
      'automations.mobile.hostUnavailable',
      'Automations are unavailable on this host. Update Orca on that host and reconnect.'
    )
  }
  if (/disconnect|connection|cutover|closed|timeout/i.test(message)) {
    return translate(
      'automations.mobile.hostUnreachable',
      'Could not reach this host. Reconnect, then refresh to check its current state.'
    )
  }
  return translate(
    'automations.mobile.actionFailed',
    'Could not complete this action on the host. Refresh and try again.'
  )
}
