import { app, ipcMain } from 'electron'
import path from 'node:path'
import { z } from 'zod'
import type { Store } from '../persistence/loading-store/store'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import { generateWorktreeIconRequest } from '../text-generation/worktree-icon-requests'

const GenerateWorktreeIcon = z.object({ name: z.string() })

export function registerWorktreeIconGenerationHandlers(
  store: Pick<Store, 'getSettings'>,
  commitMessageAgentEnv?: CommitMessageAgentEnvironmentResolvers
): void {
  const host = {
    getSettings: () => store.getSettings(),
    getAgentEnvironment: () => commitMessageAgentEnv,
    cacheFile: path.join(app.getPath('userData'), 'worktree-icons.json')
  }
  ipcMain.handle('worktreeIcons:generate', (_event, args: unknown) =>
    generateWorktreeIconRequest(host, GenerateWorktreeIcon.parse(args).name)
  )
}
