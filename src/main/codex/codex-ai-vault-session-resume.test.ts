import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AiVaultPrepareSessionResumeArgs } from '../../shared/ai-vault-resume-preparation'
import { prepareCodexAiVaultSessionResume } from './codex-ai-vault-session-resume'

const { resolveHome } = vi.hoisted(() => ({
  resolveHome: vi.fn((): string | undefined => '/selected/overlay-for-original-store')
}))
vi.mock('./codex-launch-home', () => ({ resolveCodexLaunchHome: resolveHome }))
vi.mock('./codex-home-paths', () => ({ getSystemCodexHomePath: () => '/system/.codex' }))
const row: AiVaultPrepareSessionResumeArgs = {
  agent: 'codex',
  executionHostId: LOCAL_EXECUTION_HOST_ID,
  codexHome: '/original/home',
  filePath: '/original/home/sessions/2026/10/27/rollout-thread.jsonl'
}
beforeEach(() => resolveHome.mockClear())
describe('History resumes retain the conversation store', () => {
  it.each([false, true])(
    'routes resume/fork=%s through the selected login over the row store',
    async (fork) => {
      const ready = vi.fn(async () => {})
      const result = await prepareCodexAiVaultSessionResume(
        { ...row, fork },
        {
          runtimeHome: {
            isHostSystemDefaultRealHomeSelected: () => false,
            resolveSelectedHostAccountCodexHomePathForResume: () => '/selected/home',
            getHostCodexHomePathsForSessionDiscovery: () => ['/original/home', '/selected/home']
          },
          storeHomePath: undefined,
          preparePinnedLaunchHome: ready
        }
      )
      expect(result).toEqual({
        useRealCodexHome: false,
        substituteCodexHome: '/selected/overlay-for-original-store'
      })
      expect(resolveHome).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedAccount: { homePath: '/selected/home' },
          conversationHome: '/original/home'
        })
      )
      expect(ready).toHaveBeenCalledWith('/selected/overlay-for-original-store')
    }
  )
  it('uses the system login independently of the configured conversation folder', async () => {
    const options = {
      runtimeHome: null,
      storeHomePath: '/configured/conversations',
      preparePinnedLaunchHome: async () => {}
    }
    await prepareCodexAiVaultSessionResume(row, options)
    expect(resolveHome).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectedAccount: null,
        systemHome: '/system/.codex',
        conversationHome: '/original/home'
      })
    )
    await prepareCodexAiVaultSessionResume({ ...row, codexHome: null }, options)
    expect(resolveHome).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectedAccount: null,
        systemHome: '/system/.codex',
        conversationHome: '/configured/conversations'
      })
    )
  })
  it('propagates an unreadable selection before resolving any other login', async () => {
    await expect(
      prepareCodexAiVaultSessionResume(row, {
        runtimeHome: {
          isHostSystemDefaultRealHomeSelected: () => false,
          resolveSelectedHostAccountCodexHomePathForResume: () => {
            throw new Error('temporarily unreadable')
          },
          getHostCodexHomePathsForSessionDiscovery: () => []
        },
        storeHomePath: undefined,
        preparePinnedLaunchHome: async () => {}
      })
    ).rejects.toThrow('temporarily unreadable')
    expect(resolveHome).not.toHaveBeenCalled()
  })
})
