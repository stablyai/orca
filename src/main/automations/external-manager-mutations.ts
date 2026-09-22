import type {
  ExternalAutomationAction,
  ExternalAutomationActionInput,
  ExternalAutomationCreateInput,
  ExternalAutomationProvider,
  ExternalAutomationUpdateInput
} from '../../shared/automations-types'
import { assertExternalAutomationJobId } from './external-manager-job-id'
import { runLocalAutomationCommand } from './external-manager-local-command'
import { requireExternalAutomationMultiplexer } from './external-manager-relay'
import { clearHermesCronOutputRunCountCache } from './hermes-cron-output'

const PROVIDER_ACTION_COMMANDS: Record<
  ExternalAutomationProvider,
  Record<ExternalAutomationAction, string>
> = {
  hermes: { pause: 'pause', resume: 'resume', run: 'run', delete: 'remove' },
  openclaw: { pause: 'disable', resume: 'enable', run: 'run', delete: 'rm' }
}

/** Fails closed like its neighbours: an unlisted or inherited key is not an action. */
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

function normalizeHermesCronMutationInput(input: ExternalAutomationCreateInput): {
  name: string
  prompt: string
  schedule: string
  workdir: string | null
} {
  if (input.provider !== 'hermes') {
    throw new Error('Only Hermes cron creation and editing are supported.')
  }
  const name = input.name.trim()
  const prompt = input.prompt.trim()
  const schedule = input.schedule.trim()
  const workdir = input.workdir?.trim() || null
  if (!prompt) {
    throw new Error('Hermes cron requires a prompt.')
  }
  if (!schedule) {
    throw new Error('Hermes cron requires a schedule.')
  }
  return {
    name: name || prompt.slice(0, 50).trim() || 'Hermes cron',
    prompt,
    schedule,
    workdir
  }
}

/** Edit args when `jobId` is given, create args otherwise; both are argv, never a shell string. */
function hermesCronMutationArgs(
  jobId: string | null,
  input: { name: string; prompt: string; schedule: string; workdir: string | null }
): string[] {
  const args = jobId
    ? ['cron', 'edit', jobId, '--schedule', input.schedule, '--prompt', input.prompt]
    : ['cron', 'create', input.schedule, input.prompt]
  args.push('--name', input.name)
  if (!jobId) {
    args.push('--deliver', 'local')
  }
  if (input.workdir) {
    args.push('--workdir', input.workdir)
  }
  return args
}

export async function createExternalAutomation(
  input: ExternalAutomationCreateInput
): Promise<void> {
  const normalized = normalizeHermesCronMutationInput(input)
  if (input.target.type === 'local') {
    await runLocalAutomationCommand('hermes', hermesCronMutationArgs(null, normalized))
    clearHermesCronOutputRunCountCache()
    return
  }
  await requireExternalAutomationMultiplexer(input.target.connectionId).request(
    'externalAutomations.create',
    {
      provider: input.provider,
      ...normalized
    }
  )
}

export async function updateExternalAutomation(
  input: ExternalAutomationUpdateInput
): Promise<void> {
  assertExternalAutomationJobId(input.jobId)
  const normalized = normalizeHermesCronMutationInput(input)
  if (input.target.type === 'local') {
    await runLocalAutomationCommand('hermes', hermesCronMutationArgs(input.jobId, normalized))
    clearHermesCronOutputRunCountCache(input.jobId)
    return
  }
  await requireExternalAutomationMultiplexer(input.target.connectionId).request(
    'externalAutomations.update',
    {
      provider: input.provider,
      jobId: input.jobId,
      ...normalized
    }
  )
}

export async function runExternalAutomationAction(
  input: ExternalAutomationActionInput
): Promise<void> {
  assertExternalAutomationJobId(input.jobId)
  const command = providerActionCommand(input.provider, input.action)
  if (input.target.type === 'local') {
    await runLocalAutomationCommand(input.provider, ['cron', command, input.jobId])
    if (input.provider === 'hermes') {
      clearHermesCronOutputRunCountCache(input.jobId)
    }
    return
  }
  await requireExternalAutomationMultiplexer(input.target.connectionId).request(
    'externalAutomations.act',
    {
      provider: input.provider,
      action: input.action,
      jobId: input.jobId
    }
  )
}
