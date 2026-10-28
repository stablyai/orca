// Install on the agent's chat host without a workspace; negotiate install.v1/remove.v1 and stream a snapshot followed by state revisions.

import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  ManagedRuntimeAgentParams,
  ManagedRuntimeCancelParams
} from '../../../../shared/rpc-contract/managed-runtime-install-params'
import { acpLaunchSpecFor } from '../../../acp/acp-launch-specs'
import { resolveAcpLaunchCommand } from '../../../acp/acp-structured-launch-resolution'
import { ManagedRuntimeInstallation } from '../../../node-runtime/managed-runtime-installation'
import { isAgentSessionPreSpawnError } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter'
import { getProfileUserDataPath } from '../../../orca-profiles/profile-storage-paths'
import { stopStructuredAgentChats } from '../../structured-agent-chat-stop'
import { resolveHostStructuredAgentLaunchEnvironment } from '../../structured-agent-launch-support'
import { isPathInsideOrEqual } from '../../../../shared/cross-platform-path'
import { defineMethod, defineStreamingMethod } from '../core'
import { bindStructuredAgentSessionStream } from './structured-agent-session-status-stream'

const installations = new Map<string, ManagedRuntimeInstallation>()

function installationFor(agent: string, runtime: OrcaRuntimeService): ManagedRuntimeInstallation {
  const spec = acpLaunchSpecFor(agent)
  if (!spec?.managedRuntime) {
    throw new Error(`Orca installs no runtime for ${agent}.`)
  }
  const dataDirectory = getProfileUserDataPath()
  const releases = spec.managedRuntime.root(dataDirectory)
  // Use the launch's own lookup to find external runtimes.
  const findExternal = async (): Promise<boolean> => {
    const settings = runtime.requireStore().getSettings()
    const env = {
      ...(await resolveHostStructuredAgentLaunchEnvironment(agent, settings)),
      ...spec.env
    }
    try {
      const command = resolveAcpLaunchCommand(spec, env, {
        commandSettings: settings,
        dataDirectory
      })
      return command !== spec.command && !isPathInsideOrEqual(releases, command)
    } catch (error) {
      // An unrunnable Command setting refuses start; it is not an external runtime copy.
      if (isAgentSessionPreSpawnError(error)) {
        return false
      }
      throw error
    }
  }
  const { launchGate } = spec
  const managedRuntime = spec.managedRuntime
  // Chats, starts, copies, sign-ins and children not proven gone all hold the gate's fence.
  const fence = (work: () => Promise<void>): Promise<void> =>
    launchGate
      ? launchGate.run(() => stopStructuredAgentChats(agent, managedRuntime.label), work)
      : Promise.reject(new Error(`${managedRuntime.label} cannot be removed on this host.`))
  const installation =
    installations.get(agent) ??
    // The chat host's own state root, where its launches look.
    new ManagedRuntimeInstallation(agent, managedRuntime, {
      dataDirectory,
      findExternal,
      fence
    })
  installations.set(agent, installation)
  return installation
}

export const MANAGED_RUNTIME_INSTALL_METHODS = [
  defineStreamingMethod({
    name: 'managedRuntime.subscribe',
    permission: 'workspace',
    params: ManagedRuntimeAgentParams,
    handler: async ({ agent }, ctx, emit) => {
      const installation = installationFor(agent, ctx.runtime)
      // A failed first read fails the subscribe; a later one keeps the client's last snapshot.
      let shown = await installation.status()
      const frame = ctx.requestId ? `:${ctx.requestId}` : ''
      const subscriptionId = `managedRuntime:${ctx.connectionId ?? 'local'}:${agent}${frame}`
      let dispose = (): void => {}
      const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => dispose())
      if (stream.isClosed()) {
        return
      }
      let reading = false
      let again = false
      // One read at a time; revisions during it coalesce into one more read.
      const follow = async (): Promise<void> => {
        again = true
        if (reading) {
          return
        }
        reading = true
        try {
          while (again && !stream.isClosed()) {
            again = false
            const next = await installation.status(false)
            if (next.revision !== shown.revision && !stream.isClosed()) {
              shown = next
              emit(next)
            }
          }
        } catch (error) {
          console.warn(`[managed-runtime] ${agent} status not read for a subscriber:`, error)
        } finally {
          reading = false
        }
      }
      dispose = installation.subscribe(() => void follow())
      emit(shown)
      // Catches a revision between the first read and the subscribe.
      void follow()
    }
  }),
  defineMethod({
    name: 'managedRuntime.install',
    permission: 'host-admin',
    params: ManagedRuntimeAgentParams,
    handler: async ({ agent }, { runtime }) => {
      const installation = installationFor(agent, runtime)
      installation.install()
      return installation.status()
    }
  }),
  defineMethod({
    name: 'managedRuntime.cancel',
    permission: 'host-admin',
    params: ManagedRuntimeCancelParams,
    handler: async ({ agent, operationId }, { runtime }) => {
      // The outcome once the run has unwound: `cancelled`, or `succeeded` if it had committed.
      return await installationFor(agent, runtime).cancel(operationId)
    }
  }),
  defineMethod({
    name: 'managedRuntime.remove',
    permission: 'host-admin',
    params: ManagedRuntimeAgentParams,
    handler: async ({ agent }, { runtime }) => {
      const installation = installationFor(agent, runtime)
      installation.remove()
      return installation.status()
    }
  })
] as const
