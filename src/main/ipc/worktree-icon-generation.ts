import { app, ipcMain, type WebContents } from 'electron'
import path from 'node:path'
import { z } from 'zod'
import type { Store } from '../persistence/loading-store/store'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import { generateWorktreeIconRequest } from '../text-generation/worktree-icon-requests'
import { addFanoutListener } from '../runtime/events/event-listener-fanout'

const CancelWorktreeIcon = z.object({ requestId: z.string().min(1).max(128) })
const GenerateWorktreeIcon = CancelWorktreeIcon.extend({ name: z.string() })

export function registerWorktreeIconGenerationHandlers(
  store: Pick<Store, 'getSettings'>,
  commitMessageAgentEnv?: CommitMessageAgentEnvironmentResolvers
): void {
  const host = {
    getSettings: () => store.getSettings(),
    getAgentEnvironment: () => commitMessageAgentEnv,
    cacheFile: path.join(app.getPath('userData'), 'worktree-icons.json')
  }
  const requests = new WeakMap<WebContents, Map<string, AbortController>>()
  ipcMain.handle('worktreeIcons:generate', async (event, args: unknown) => {
    const { name, requestId } = GenerateWorktreeIcon.parse(args)
    let owned = requests.get(event.sender)
    if (!owned) {
      owned = new Map()
      requests.set(event.sender, owned)
    }
    owned.get(requestId)?.abort()
    const controller = new AbortController()
    owned.set(requestId, controller)
    const cancel = (): void => controller.abort()
    const releaseDestroyed = addFanoutListener(event.sender, 'destroyed', cancel)
    const releaseCrashed = addFanoutListener(event.sender, 'render-process-gone', cancel)
    const releaseNavigated = addFanoutListener(event.sender, 'did-navigate', cancel)
    try {
      return await generateWorktreeIconRequest(host, name, controller.signal)
    } finally {
      releaseDestroyed()
      releaseCrashed()
      releaseNavigated()
      if (owned.get(requestId) === controller) {
        owned.delete(requestId)
      }
    }
  })
  ipcMain.handle('worktreeIcons:cancel', (event, args: unknown) => {
    requests.get(event.sender)?.get(CancelWorktreeIcon.parse(args).requestId)?.abort()
  })
}
