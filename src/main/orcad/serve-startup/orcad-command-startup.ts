import { startOrcad } from '../host-runtime/orcad-entry'
import process from 'node:process'
import { resolveOrcadInstallRoot } from '../host-runtime/orcad-app-paths'
import { ORCAD_USAGE, parseArgs } from './orcad-command-arguments'
import {
  installOrcadShutdownSignals,
  type OrcadShutdownTrigger
} from '../host-lifecycle/orcad-lifecycle'
import { installOrcadProcessErrorGuards } from '../host-lifecycle/orcad-process-error-guards'
import { installOrcadStopRequestListeners } from '../host-lifecycle/managed-stop/orcad-stop-request-listener'
import { prepareOrcadManagedStop } from '../host-lifecycle/managed-stop/orcad-managed-stop-admission'
import { bindOrcadIdleShutdown } from '../host-lifecycle/idle-exit/orcad-managed-idle-exit-host'

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
