import type { TerminalModelDiscoveryParams } from '../../shared/rpc-contract/agent-model-discovery-params'
import { hostQualifiedRepoSelector } from '../runtime/workspaces/catalog/runtime-repo-selector'
import { ipcMain } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
export function registerTerminalModelDiscoveryHandler(runtime: OrcaRuntimeService): void {
  ipcMain.removeHandler('agent:discoverTerminalModels')
  ipcMain.handle('agent:discoverTerminalModels', (_event, args: TerminalModelDiscoveryParams) =>
    runtime.discoverTerminalModels(args.worktree, args.agentId, {
      ...(args.repo ? { repo: hostQualifiedRepoSelector(args.repo, args.repoHostId) } : {}),
      folder: args.folder,
      cwd: args.cwd,
      uncached: args.uncached
    })
  )
}
