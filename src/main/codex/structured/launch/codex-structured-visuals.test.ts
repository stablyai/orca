import { describe, expect, it, vi } from 'vitest'
import type { NativeChatVisualsLaunch } from '../../../native-chat/native-chat-visuals-delivery'
import { CodexAppServerTimeoutError } from '../../app-server/codex-app-server-session'
import { prepareCodexThreadForVisuals } from './codex-structured-visuals'

import { codexStructuredPermissionPolicy } from '../../../../shared/codex-permission-policy'

const VISUALS: NativeChatVisualsLaunch = {
  folder: '/state/chat-scratch/abc',
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
  it('overrides nothing when the user roots cannot be read, so none are dropped', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() }
    for (const route of [
      () => Promise.reject(new CodexAppServerTimeoutError('config/read exceeded 2000ms')),
      configWithRoots([42]),
      () => ({ nothing: true })
    ]) {
      const { connection } = connectionAnswering({ 'config/read': route })
      await expect(
        prepareCodexThreadForVisuals(
          connection,
          { cwd: '/w', visuals: VISUALS, permissionPolicy: MANUAL },
          { logger, sessionId: 's-1' }
        )
      ).resolves.toBeNull()
    }
    expect(logger.warn).toHaveBeenCalledTimes(3)
  })
})
