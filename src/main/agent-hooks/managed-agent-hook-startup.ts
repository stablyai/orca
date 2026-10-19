import { recordManagedHookInstallFailure } from './install-telemetry'
import {
  installManagedAgentHooks,
  resolveStartupManagedHookAction,
  shouldContinueManagedHookStartup
} from './managed-agent-hook-controls'

type StartupHookSettings = NonNullable<Parameters<typeof installManagedAgentHooks>[0]>

/** Installs or refreshes this host's managed agent hooks once at process start; never removes. */
export function reconcileStartupManagedAgentHooks(host: {
  getSettings: () => StartupHookSettings
  isQuitting: () => boolean
  shouldHydrateShellPath: boolean
}): void {
  // Why skip rather than remove when the off switch is set: the hook files are user-global but this
  // decision reads only THIS profile's settings, so removing here deletes the hooks every other Orca
  // instance depends on (STA-5679). Skipping already keeps removed hooks from reappearing on launch.
  if (resolveStartupManagedHookAction(host.getSettings()) !== 'install') {
    return
  }
  void installManagedAgentHooks(host.getSettings(), {
    shouldHydrateShellPath: host.shouldHydrateShellPath,
    onInstallError: recordManagedHookInstallFailure,
    shouldContinue: (agent) =>
      shouldContinueManagedHookStartup(host.isQuitting(), host.getSettings(), agent)
  }).catch((error: unknown) =>
    console.warn('[agent-hooks] failed to reconcile managed hooks on startup:', error)
  )
}
