import { describe, expect, it, vi } from 'vitest'
import type { AiVaultPrepareSessionResumeArgs } from '../../shared/ai-vault-resume-preparation'
import { prepareAiVaultSessionResume } from './ai-vault-resume'
import { scanRuntimeAiVaultSessions } from './ai-vault-runtime-scan'
import { resolveAiVaultSessionTitlesByHost } from './ai-vault-session-title-routing'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../ai-vault/session-title-resolver', () => ({
  resolveLocalAiVaultSessionTitles: vi.fn()
}))
vi.mock('./ssh', () => ({ requestActiveSshAiVaultSessionTitles: vi.fn() }))

const executionHostId = 'runtime:unresolved-owner' as const

describe('AI Vault unresolved workspace owner routing', () => {
  it('returns a host issue without scanning a runtime environment', async () => {
    const scanner = vi.fn()

    const result = await scanRuntimeAiVaultSessions({
      hostInfo: { environmentId: 'unresolved-owner', executionHostId },
      scanner
    })

    expect(result.sessions).toEqual([])
    expect(result.issues).toEqual([
      expect.objectContaining({
        executionHostId,
        kind: 'host',
        path: 'unresolved-owner',
        message: expect.stringContaining('ownership is unresolved')
      })
    ])
    expect(scanner).not.toHaveBeenCalled()
  })

  it('settles title resolution without calling a runtime environment', async () => {
    const resolveRuntime = vi.fn()

    await expect(
      resolveAiVaultSessionTitlesByHost(
        {
          executionHostScope: executionHostId,
          requests: [{ agent: 'codex', sessionId: 'session-1' }]
        },
        resolveRuntime
      )
    ).resolves.toEqual({ titles: [] })
    expect(resolveRuntime).not.toHaveBeenCalled()
  })

  it('rejects resume without preparing on a runtime environment', async () => {
    const prepareSessionResume = vi.fn()
    const prepareRuntimeSessionResume = vi.fn()
    const args: AiVaultPrepareSessionResumeArgs = {
      agent: 'codex',
      filePath: '/managed/sessions/rollout.jsonl',
      codexHome: '/managed',
      executionHostId
    }

    await expect(
      prepareAiVaultSessionResume(args, { prepareSessionResume, prepareRuntimeSessionResume })
    ).rejects.toThrow('The session host is unavailable')
    expect(prepareSessionResume).not.toHaveBeenCalled()
    expect(prepareRuntimeSessionResume).not.toHaveBeenCalled()
  })
})
