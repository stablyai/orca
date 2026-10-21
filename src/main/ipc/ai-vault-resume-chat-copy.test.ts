import { afterEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { installCopyingChat } from '../ai-vault/structured-session-ownership.test-support'
import type { AiVaultPrepareSessionResumeArgs } from '../../shared/ai-vault-resume-preparation'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const { prepareAiVaultSessionResume } = await import('./ai-vault-resume')

const OMP_ID = '019fd611-2b3c-7d4e-9f50-6b7c8d9e0f1a'
const forkArgs = (
  executionHostId: AiVaultPrepareSessionResumeArgs['executionHostId']
): AiVaultPrepareSessionResumeArgs => ({
  agent: 'omp',
  sessionId: OMP_ID,
  filePath: `/Users/me/.omp/agent/sessions/--repo--/x_${OMP_ID}.jsonl`,
  codexHome: null,
  executionHostId,
  fork: true
})

afterEach(() => setStructuredAgentSessionHost(null))

describe('Resume in New CLI preparation for a chat whose host makes the copy', () => {
  it('leaves the copy to the server that runs a remote chat', async () => {
    const copy = vi.fn(async () => ({
      sessionId: 'local-copy'
    }))
    installCopyingChat({ transport: 'acp', agent: 'omp', nativeId: 'unrelated' }, copy)
    const prepareRuntimeSessionResume = vi.fn(async () => ({
      useRealCodexHome: false,
      forkedSession: {
        sessionId: 'remote-copy',
        filePath: '/sessions/remote-copy.jsonl',
        agent: 'omp' as const
      }
    }))

    await expect(
      prepareAiVaultSessionResume(forkArgs('runtime:env-1'), { prepareRuntimeSessionResume })
    ).resolves.toEqual({
      useRealCodexHome: false,
      forkedSession: {
        sessionId: 'remote-copy',
        filePath: '/sessions/remote-copy.jsonl',
        agent: 'omp'
      }
    })
    expect(prepareRuntimeSessionResume).toHaveBeenCalledWith('env-1', forkArgs('runtime:env-1'))
    expect(copy).not.toHaveBeenCalled()
  })
})
