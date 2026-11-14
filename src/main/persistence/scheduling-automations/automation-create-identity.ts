import type {
  Automation,
  AutomationCreateInput
} from '../../../shared/automations/automation-definition'

/** The fields a new automation keeps from how it was asked for: its retry key and its creator. */
export function automationCreateIdentity(
  input: Pick<AutomationCreateInput, 'creationKey' | 'createdBy'>
): Pick<Automation, 'creationKey' | 'createdBy'> {
  return {
    ...(input.creationKey ? { creationKey: input.creationKey } : {}),
    ...(input.createdBy ? { createdBy: input.createdBy } : {})
  }
}
