// The window asks the control plane to run the repo's orca.yaml `scripts.archive` in
// the VM before an archive or a delete, and what it knows about the hook while the VM sleeps.
// Every outcome is logged here; the window shows it and decides whether to go on.
import { ipcMain } from 'electron'
import {
  ORCA_CLOUD_WORKSPACE_CHANNELS as CH,
  type CloudWorkspaceTarget
} from '../../shared/hosted-sandbox/cloud-workspace-api'
import { cloudSandboxIdForEnvironment } from './hosted-remote-desktop'
import { findCloudSandbox } from './cloud-workspace-target'
import type { HostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'
import { NOT_CLOUD, failure } from './hosted-workspace-runtime'

function sandboxFor(userDataPath: string, args: CloudWorkspaceTarget): string | null {
  return (
    findCloudSandbox(userDataPath, args)?.sandboxId ??
    (args.environmentId ? cloudSandboxIdForEnvironment(userDataPath, args.environmentId) : null) ??
    null
  )
}

export function registerCloudArchiveHookHandlers(
  userDataPath: string,
  client: Pick<HostedSandboxControlPlaneClient, 'runArchiveHook' | 'archiveHookState'>,
  log: (line: string) => void = console.log
): void {
  ipcMain.handle(CH.archiveHookState, async (_event, args: CloudWorkspaceTarget) => {
    const sandboxId = sandboxFor(userDataPath, args)
    if (!sandboxId) {
      return NOT_CLOUD
    }
    try {
      return { ok: true, value: await client.archiveHookState(sandboxId) }
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle(
    CH.runArchiveHook,
    async (_event, args: CloudWorkspaceTarget & { wake?: boolean }) => {
      const sandboxId = sandboxFor(userDataPath, args)
      if (!sandboxId) {
        return NOT_CLOUD
      }
      const startedAt = Date.now()
      try {
        const result = await client.runArchiveHook(sandboxId, args.wake ? { wake: true } : {})
        const codes =
          'runs' in result
            ? ` exits=${result.runs.map((run) => (run.timedOut ? 'timeout' : run.exitCode)).join(',')}${result.reason ? ` reason=${result.reason}` : ''}`
            : ''
        log(
          `[orca-cloud] archive hook ${sandboxId}: ${result.state}${codes} (${Date.now() - startedAt} ms)`
        )
        return { ok: true, value: result }
      } catch (error) {
        log(`[orca-cloud] archive hook ${sandboxId} request failed: ${String(error)}`)
        return failure(error)
      }
    }
  )
}
