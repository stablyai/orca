import { startOrcad } from './orcad-entry'
import process from 'node:process'
import { resolveOrcadInstallRoot } from './orcad-app-paths'
import { ORCAD_USAGE, parseArgs } from './orcad-command-arguments'
import { installOrcadShutdownSignals, type OrcadShutdownTrigger } from './orcad-lifecycle'
import { installOrcadProcessErrorGuards } from './orcad-process-error-guards'
import { installOrcadStopRequestListeners } from './orcad-stop-request-listener'
import { prepareOrcadManagedStop } from './orcad-managed-stop-admission'
import { bindOrcadIdleShutdown } from './orcad-managed-idle-exit-host'

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(ORCAD_USAGE)
    return
  }
  let shutdownTrigger: OrcadShutdownTrigger | null = null
  // Fire-and-forget startup work can reject before its first await completes.
  installOrcadProcessErrorGuards(() => shutdownTrigger)
  const startup = startOrcad(options)
  const requestShutdown = installOrcadShutdownSignals(async () => (await startup).stop())
  shutdownTrigger = requestShutdown
  const handle = await startup
  // Stop requests must name the runtime/instance established by startup.
  installOrcadStopRequestListeners(() => requestShutdown('stop request'), {
    installRoot: resolveOrcadInstallRoot(),
    managedStop: handle.managedStop,
    beforeManagedStop: prepareOrcadManagedStop
  })
  bindOrcadIdleShutdown(requestShutdown)
}
