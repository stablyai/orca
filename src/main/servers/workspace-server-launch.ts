import { realpath } from 'node:fs/promises'
import { beginTerminalInstall } from '../ipc/watcher-removal-gate'
import { prepareWorkspaceServerCommand } from './workspace-server-command'
import type { WorkspaceServerProcessManager } from './workspace-server-process-manager'
import type { WorkspacePortScanResult } from '../../shared/workspace-ports'

export type ManagedWorkspaceServerStart = {
  worktree: string
  executionHostId: string
  port: number
  name: string
  command: string
  cwd: string
}

type WorkspaceServerLaunchDeps = {
  servers: WorkspaceServerProcessManager
  resolveScope: () => Promise<{ id: string; path: string }>
  scanPorts: () => Promise<WorkspacePortScanResult>
  getSettings: () => Parameters<typeof prepareWorkspaceServerCommand>[0]['settings']
}

export async function launchManagedWorkspaceServer(
  args: ManagedWorkspaceServerStart,
  deps: WorkspaceServerLaunchDeps
) {
  const permit = deps.servers.beginStart()
  try {
    const scope = await deps.resolveScope()
    const prepared = await prepareWorkspaceServerCommand({
      rootPath: scope.path,
      cwd: args.cwd,
      command: args.command,
      settings: deps.getSettings()
    })
    const scan = await deps.scanPorts()
    if (scan.unavailableReason) {
      throw new Error(scan.unavailableReason)
    }
    if (scan.ports.some((port) => port.port === args.port)) {
      throw new Error(`Port ${args.port} is already in use.`)
    }
    const confirmedScope = await deps.resolveScope()
    if ((await realpath(confirmedScope.path)) !== prepared.root) {
      throw new Error('The workspace changed while starting the server.')
    }
    // The path gate also covers accepted background Git removals. No await before spawn.
    const releaseInstall = beginTerminalInstall(prepared.root)
    try {
      return deps.servers.start(
        { worktreeId: scope.id, port: args.port, name: args.name },
        prepared.spec,
        permit
      )
    } finally {
      releaseInstall()
    }
  } finally {
    permit.release()
  }
}
