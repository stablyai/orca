import { ipcMain } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
export function registerTerminalModelDiscoveryHandler(runtime: OrcaRuntimeService): void {
  ipcMain.handle(
    'agent:discoverTerminalModels',
    (_event, args: { agentId: string; worktree?: string }) =>
      runtime.discoverTerminalModels(args.worktree, args.agentId)
  )
}
