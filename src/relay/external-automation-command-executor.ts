import {
  EXTERNAL_AUTOMATION_JOB_ID_PATTERN,
  externalAutomationProvider,
  isExternalAutomationAction,
  type ExternalAutomationAction
} from './external-automation-provider'

export type ExternalAutomationCommandRunner = (
  command: string,
  args: string[],
  options: { encoding: 'utf-8'; timeout: number }
) => Promise<unknown>

type HermesJobMutation = {
  name: string
  prompt: string
  schedule: string
  workdir: string
}

function hermesCommand(action: ExternalAutomationAction): string {
  switch (action) {
    case 'pause':
      return 'pause'
    case 'resume':
      return 'resume'
    case 'run':
      return 'run'
    case 'delete':
      return 'remove'
  }
}

function openClawCommand(action: ExternalAutomationAction): string {
  switch (action) {
    case 'pause':
      return 'disable'
    case 'resume':
      return 'enable'
    case 'run':
      return 'run'
    case 'delete':
      return 'rm'
  }
}

function normalizeHermesJobMutation(params: Record<string, unknown>): HermesJobMutation {
  const provider = externalAutomationProvider(params.provider)
  if (provider !== 'hermes') {
    throw new Error('Only Hermes cron creation and editing are supported.')
  }
  const name = typeof params.name === 'string' ? params.name.trim() : ''
  const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : ''
  const schedule = typeof params.schedule === 'string' ? params.schedule.trim() : ''
  const workdir = typeof params.workdir === 'string' ? params.workdir.trim() : ''
  if (!prompt) {
    throw new Error('Hermes cron requires a prompt.')
  }
  if (!schedule) {
    throw new Error('Hermes cron requires a schedule.')
  }
  return {
    name: name || prompt.slice(0, 50).trim(),
    prompt,
    schedule,
    workdir
  }
}

export class ExternalAutomationCommandExecutor {
  constructor(
    private readonly runCommand: ExternalAutomationCommandRunner,
    private readonly clearHermesRunCount: (jobId?: string) => void
  ) {}

  async createJob(params: Record<string, unknown> = {}): Promise<{ ok: true }> {
    const input = normalizeHermesJobMutation(params)
    const args = [
      'cron',
      'create',
      input.schedule,
      input.prompt,
      '--name',
      input.name,
      '--deliver',
      'local'
    ]
    if (input.workdir) {
      args.push('--workdir', input.workdir)
    }
    await this.runHermesCronCommand(args)
    this.clearHermesRunCount()
    return { ok: true }
  }

  async updateJob(params: Record<string, unknown> = {}): Promise<{ ok: true }> {
    const input = normalizeHermesJobMutation(params)
    const jobId = params.jobId
    if (typeof jobId !== 'string' || !EXTERNAL_AUTOMATION_JOB_ID_PATTERN.test(jobId)) {
      throw new Error('Invalid external automation job ID.')
    }
    const args = [
      'cron',
      'edit',
      jobId,
      '--schedule',
      input.schedule,
      '--prompt',
      input.prompt,
      '--name',
      input.name
    ]
    if (input.workdir) {
      args.push('--workdir', input.workdir)
    }
    await this.runHermesCronCommand(args)
    this.clearHermesRunCount(jobId)
    return { ok: true }
  }

  async runAction(params: Record<string, unknown> = {}): Promise<{ ok: true }> {
    const provider = externalAutomationProvider(params.provider)
    const action = params.action
    const jobId = params.jobId
    if (!isExternalAutomationAction(action)) {
      throw new Error('Unsupported external automation action.')
    }
    if (typeof jobId !== 'string' || !EXTERNAL_AUTOMATION_JOB_ID_PATTERN.test(jobId)) {
      throw new Error('Invalid external automation job ID.')
    }
    const command = provider === 'hermes' ? hermesCommand(action) : openClawCommand(action)
    await this.runCommand(provider, ['cron', command, jobId], {
      encoding: 'utf-8',
      timeout: 30_000
    })
    if (provider === 'hermes') {
      this.clearHermesRunCount(jobId)
    }
    return { ok: true }
  }

  private async runHermesCronCommand(args: string[]): Promise<void> {
    await this.runCommand('hermes', args, {
      encoding: 'utf-8',
      timeout: 30_000
    })
  }
}
