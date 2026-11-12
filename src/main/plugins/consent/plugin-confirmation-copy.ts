// @protected-copy: a plugin language pack must not reword what the person is asked to allow.
import { translateMain } from '../../i18n/main-i18n'
import type { PluginActionConfirmationRequest } from './plugin-action-confirmation'
import type { PluginConfirmationSubject } from './plugin-confirmation-subject'

const NAME_MAX = 120

/** A long automation name is cut so the question stays readable. */
function shortName(name: string): string {
  return name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name
}

/** The question Orca shows for a plugin's request. */
export function pluginConfirmationCopy(
  pluginName: string,
  subject: PluginConfirmationSubject
): PluginActionConfirmationRequest {
  const values = { plugin: pluginName, automation: shortName(subject.name) }
  if (subject.kind === 'automation.delete') {
    return {
      message: translateMain(
        'plugins.actionConfirmation.deleteAutomation',
        '{{plugin}} wants to delete the automation “{{automation}}”',
        values
      ),
      detail: translateMain(
        'plugins.actionConfirmation.deleteAutomationDetail',
        'The plugin did not create it. Its schedule stops and it is removed from Automations.'
      ),
      confirmLabel: translateMain('plugins.actionConfirmation.delete', 'Delete')
    }
  }
  return {
    message: translateMain(
      'plugins.actionConfirmation.changeAutomation',
      '{{plugin}} wants to change the automation “{{automation}}”',
      values
    ),
    detail: translateMain(
      'plugins.actionConfirmation.changeAutomationDetail',
      'The plugin did not create it. It would change: {{fields}}.',
      { fields: subject.fields.join(', ') }
    ),
    confirmLabel: translateMain('plugins.actionConfirmation.change', 'Change')
  }
}
