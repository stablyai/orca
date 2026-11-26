import { describe, expect, it, vi } from 'vitest'
import type { NativeChatVisualsLaunch } from '../../../native-chat/conversation-files/native-chat-visuals-delivery'
import { prepareCodexThreadSkills } from './codex-structured-skill-roots'
import { codexStructuredPermissionPolicy } from '../../../../shared/agent-launch/permissions/codex-permission-policy'

const VISUALS: NativeChatVisualsLaunch = {
  folder: '/state/chat-scratch/abc',
  temporaryFolder: '/state/chat-temporary/abc',
  skill: { pluginDir: '/app/native-chat-visuals', skillsRoot: '/app/native-chat-visuals/skills' }
}
const MANUAL = codexStructuredPermissionPolicy('ask')

type Call = { method: string; params?: Record<string, unknown>; timeoutMs?: number | null }

function connectionAnswering(routes: Record<string, () => unknown>) {
  const calls: Call[] = []
  const request = vi.fn(
    async (
      method: string,
      params?: Record<string, unknown>,
      options?: { timeoutMs?: number | null }
    ) => {
      calls.push({ method, params, timeoutMs: options?.timeoutMs })
      const route = routes[method]
      return route ? route() : {}
    }
  )
  return { calls, connection: { request } }
}

const configWithRoots = (roots: unknown) => () => ({
  config: { sandbox_workspace_write: { writable_roots: roots, network_access: true } }
})

describe('setting up a Codex app-server for a chat with visuals', () => {
  it('keeps configured roots and adds both persistent artifacts and disposable storage', async () => {
    const { connection } = connectionAnswering({
      'config/read': configWithRoots(['/user/root', VISUALS.folder])
    })
    await expect(
      prepareCodexThreadSkills(connection, {
        cwd: '/w',
        visuals: VISUALS,
        permissionPolicy: MANUAL
      })
    ).resolves.toEqual({
      rootsTaken: true,
      threadConfig: {
        'sandbox_workspace_write.writable_roots': [
          '/user/root',
          VISUALS.folder,
          VISUALS.temporaryFolder
        ]
      }
    })
  })
})
