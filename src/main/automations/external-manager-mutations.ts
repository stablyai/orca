import type {
  ExternalAutomationAction,
  ExternalAutomationActionInput,
  ExternalAutomationProvider
} from '../../shared/automations-types'
import { assertExternalAutomationJobId } from './external-manager-job-id'
import { runLocalAutomationCommand } from './external-manager-local-command'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'

const PROVIDER_ACTION_COMMANDS: Record<
  ExternalAutomationProvider,
  Record<ExternalAutomationAction, string>
> = {
  openclaw: { pause: 'disable', resume: 'enable', run: 'run', delete: 'rm' }
}

/** Reject unlisted or inherited action names. */
function providerActionCommand(
  provider: ExternalAutomationProvider,
  action: ExternalAutomationAction
): string {
  const commands = Object.hasOwn(PROVIDER_ACTION_COMMANDS, provider)
    ? PROVIDER_ACTION_COMMANDS[provider]
    : null
  const command = commands && Object.hasOwn(commands, action) ? commands[action] : null
  if (typeof command !== 'string') {
    throw new Error('Unsupported external automation action.')
  }
  return command
}

export async function runExternalAutomationAction(
  input: ExternalAutomationActionInput
): Promise<void> {
  assertExternalAutomationJobId(input.jobId)
  const command = providerActionCommand(input.provider, input.action)
  if (input.target.type === 'local') {
    await runLocalAutomationCommand(input.provider, ['cron', command, input.jobId])
    return
  }
  throw new SshHostNotServedError(input.target.connectionId)
}
