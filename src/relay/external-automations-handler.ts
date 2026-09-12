import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { RelayDispatcher } from './dispatcher'
import {
  ExternalAutomationCommandExecutor,
  type ExternalAutomationCommandRunner
} from './external-automation-command-executor'
import { ExternalAutomationProviderCatalog } from './external-automation-provider-catalog'
import { HermesRunHistory } from './hermes-run-history'

const execFileAsync = promisify(execFile)

const runExternalAutomationCommand: ExternalAutomationCommandRunner = async (
  command,
  args,
  options
) => {
  await execFileAsync(command, args, options)
}

export class ExternalAutomationsHandler {
  private readonly runHistory = new HermesRunHistory()
  private readonly commands = new ExternalAutomationCommandExecutor(
    runExternalAutomationCommand,
    (jobId) => this.runHistory.clearRunCount(jobId)
  )
  private readonly providers = new ExternalAutomationProviderCatalog(
    runExternalAutomationCommand,
    (params) => this.runHistory.listRuns(params)
  )

  constructor(dispatcher: RelayDispatcher) {
    dispatcher.onRequest('externalAutomations.list', (params) => this.providers.listJobs(params))
    dispatcher.onRequest('externalAutomations.runs', (params) => this.runHistory.listRuns(params))
    dispatcher.onRequest('externalAutomations.create', (params) => this.commands.createJob(params))
    dispatcher.onRequest('externalAutomations.update', (params) => this.commands.updateJob(params))
    dispatcher.onRequest('externalAutomations.act', (params) => this.commands.runAction(params))
  }
}
