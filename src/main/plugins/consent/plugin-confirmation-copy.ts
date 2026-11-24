// @protected-copy: a plugin language pack must not reword what the person is asked to allow.
import { translateMain } from '../../i18n/main-i18n'
import type { PluginActionConfirmationRequest } from './plugin-action-confirmation'
import type {
  PluginConfirmationAutomation,
  PluginConfirmationSubject
} from './plugin-confirmation-subject'

const NAME_MAX = 120
const PROMPT_EXCERPT_MAX = 400

/** Long text is cut, on one line, so the question stays readable. */
function excerpt(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** The line that says which automation this is: its short id, where and when it runs. */
function automationIdentity(automation: PluginConfirmationAutomation): string {
  const values = {
    id: automation.id.slice(0, 8),
    project:
      automation.project ??
      translateMain('plugins.actionConfirmation.unknownProject', 'an unknown project'),
    schedule: excerpt(automation.schedule, NAME_MAX)
  }
  return automation.workspace === null
    ? translateMain(
        'plugins.actionConfirmation.automationNewWorkspaces',
        'Automation {{id}}: a new workspace of {{project}} each run, on {{schedule}}.',
        values
      )
    : translateMain(
        'plugins.actionConfirmation.automationInWorkspace',
        'Automation {{id}}: in {{project}} / {{workspace}}, on {{schedule}}.',
        { ...values, workspace: excerpt(automation.workspace, NAME_MAX) }
      )
}

/** The question Orca shows for a plugin's request. */
export function pluginConfirmationCopy(
  pluginName: string,
  subject: PluginConfirmationSubject
): PluginActionConfirmationRequest {
  const values = { plugin: pluginName, automation: excerpt(subject.automation.name, NAME_MAX) }
  const identity = automationIdentity(subject.automation)
  if (subject.kind === 'automation.delete') {
    return {
      message: translateMain(
        'plugins.actionConfirmation.deleteAutomation',
        '{{plugin}} wants to delete the automation “{{automation}}”',
        values
      ),
      detail: [
        identity,
        translateMain(
          'plugins.actionConfirmation.deleteAutomationDetail',
          'The plugin did not create it. Its schedule stops and it is removed from Automations.'
        )
      ].join('\n\n'),
      confirmLabel: translateMain('plugins.actionConfirmation.delete', 'Delete')
    }
  }
  return {
    message: translateMain(
      'plugins.actionConfirmation.changeAutomation',
      '{{plugin}} wants to change the automation “{{automation}}”',
      values
    ),
    detail: [
      identity,
      subject.elevated
        ? translateMain(
            'plugins.actionConfirmation.changeElevatedAutomationDetail',
            'It runs its agent with extra settings you chose (arguments, a permission mode or a precheck command). It would change: {{fields}}.',
            { fields: subject.fields.join(', ') }
          )
        : translateMain(
            'plugins.actionConfirmation.changeAutomationDetail',
            'The plugin did not create it. It would change: {{fields}}.',
            { fields: subject.fields.join(', ') }
          ),
      subject.prompt === undefined
        ? null
        : translateMain('plugins.actionConfirmation.newPrompt', 'New prompt: “{{prompt}}”', {
            prompt: excerpt(subject.prompt, PROMPT_EXCERPT_MAX)
          })
    ]
      .filter((line) => line !== null)
      .join('\n\n'),
    confirmLabel: translateMain('plugins.actionConfirmation.change', 'Change')
  }
}
