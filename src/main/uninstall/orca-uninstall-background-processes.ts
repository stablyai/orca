// The `orca serve` service and the terminal daemon: the processes Orca leaves running.
import {
  listInstalledServeServiceUnits,
  removeServeServiceUnit,
  runServeServiceManager
} from '../../shared/remote-runtime/serve-supervisor/serve-service-unit-removal'
import { collapseHomePath } from '../../shared/skills/bundled/bundled-skill-locations'
import type {
  OrcaUninstallPlan,
  OrcaUninstallSimpleEntry
} from '../../shared/uninstall/orca-uninstall-types'
import { daemonRuntimeDirFor } from '../daemon/endpoint/publication/daemon-runtime-dir'
import type { OrcaUninstallHost } from './orca-uninstall-cleanup'
import { orcaUninstallErrorText as errorText } from './orca-uninstall-error-text'

export async function serviceEntry(
  host: OrcaUninstallHost
): Promise<OrcaUninstallSimpleEntry | null> {
  const units = await listInstalledServeServiceUnits(host.platform, host.homeDir)
  return units.length === 0
    ? null
    : { location: units.map((unit) => unit.name).join(', '), state: 'present', detail: null }
}

export async function terminalDaemonEntry(
  host: OrcaUninstallHost
): Promise<OrcaUninstallSimpleEntry | null> {
  return (await host.isTerminalDaemonLive().catch(() => false))
    ? {
        location: collapseHomePath(daemonRuntimeDirFor(host.userDataPath), host.homeDir),
        state: 'present',
        detail: null
      }
    : null
}

export async function runBackgroundService(
  plan: OrcaUninstallPlan,
  host: OrcaUninstallHost
): Promise<OrcaUninstallSimpleEntry | null> {
  const entry = plan.backgroundService
  if (!entry || entry.state === 'removed') {
    return entry
  }
  const run = host.runServiceManager ?? runServeServiceManager
  try {
    for (const unit of await listInstalledServeServiceUnits(host.platform, host.homeDir)) {
      await removeServeServiceUnit(unit, run, host.uid)
    }
  } catch (error) {
    return { ...entry, state: 'error', detail: errorText(error) }
  }
  const left = await listInstalledServeServiceUnits(host.platform, host.homeDir)
  return left.length === 0
    ? { ...entry, state: 'removed', detail: null }
    : { ...entry, state: 'error', detail: `Still installed: ${left.map((u) => u.name).join(', ')}` }
}

export async function runTerminalDaemon(
  plan: OrcaUninstallPlan,
  host: OrcaUninstallHost
): Promise<OrcaUninstallSimpleEntry | null> {
  const entry = plan.terminalDaemon
  if (!entry || entry.state === 'removed') {
    return entry
  }
  try {
    await host.stopTerminalDaemon()
    return { ...entry, state: 'removed', detail: null }
  } catch (error) {
    return { ...entry, state: 'error', detail: errorText(error) }
  }
}
