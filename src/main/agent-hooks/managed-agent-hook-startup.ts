import { recordManagedHookInstallFailure } from './install-telemetry'
import {
  installManagedAgentHooks,
  resolveStartupManagedHookAction,
  shouldContinueManagedHookStartup
} from './managed-agent-hook-controls'

type StartupHookSettings = NonNullable<Parameters<typeof installManagedAgentHooks>[0]>

export function reconcileStartupManagedAgentHooks(host: {
  getSettings: () => StartupHookSettings
  isQuitting: () => boolean
  shouldHydrateShellPath: boolean
}): void {
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
