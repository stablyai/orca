import { afterEach, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  installCopyingChat,
  PROVIDER_SESSION
} from '../ai-vault/structured-session-ownership.test-support'
import { prepareAiVaultSessionResume } from './ai-vault-resume'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
const wakeMock = vi.hoisted(() => vi.fn(async (_distro: string | null) => {}))
vi.mock('../native-chat/native-chat-open-wake', () => ({
  wakeNativeChatTranscriptDistro: wakeMock
}))
afterEach(() => setStructuredAgentSessionHost(null))

it('refuses the native owner while preserving forks and other execution hosts', async () => {
  installCopyingChat(
    { transport: 'acp', agent: 'omp', nativeId: PROVIDER_SESSION },
    vi.fn(async () => ({ sessionId: 'copy-1', filePath: '/sessions/copy-1.jsonl' }))
  )
  const local = {
    agent: 'omp' as const,
    sessionId: PROVIDER_SESSION,
    filePath: '/sessions/conversation.jsonl',
    codexHome: null,
    executionHostId: 'local' as const
  }
  const prepareSessionResume = vi.fn().mockResolvedValue({ useRealCodexHome: false })
  const prepareRuntimeSessionResume = vi.fn().mockResolvedValue({ useRealCodexHome: false })
  const options = { prepareSessionResume, prepareRuntimeSessionResume }
  await expect(prepareAiVaultSessionResume(local, options)).rejects.toThrow(
    'agent_session_conflict'
  )
  expect(prepareSessionResume).not.toHaveBeenCalled()
  await expect(prepareAiVaultSessionResume({ ...local, fork: true }, options)).resolves.toEqual({
    useRealCodexHome: false,
    forkedSession: { agent: 'omp', sessionId: 'copy-1', filePath: '/sessions/copy-1.jsonl' }
  })
  const paired = { ...local, executionHostId: 'runtime:paired' as const }
  await expect(prepareAiVaultSessionResume(paired, options)).resolves.toEqual({
    useRealCodexHome: false
  })
  expect(prepareRuntimeSessionResume).toHaveBeenCalledWith('paired', paired)
  await expect(
    prepareAiVaultSessionResume({ ...local, executionHostId: 'ssh:server' }, options)
  ).resolves.toEqual({ useRealCodexHome: false })
  const wsl = { ...local, filePath: String.raw`\\wsl.localhost\Ubuntu\home\qa\session.jsonl` }
  await expect(prepareAiVaultSessionResume(wsl, options)).resolves.toEqual({
    useRealCodexHome: false
  })
  expect(prepareSessionResume).toHaveBeenCalledWith(wsl)
})

// Resuming is a user act: its stopped distro must start before the transcript's gated reads.
it('starts the session file distro before preparing a WSL resume', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    const prepareSessionResume = vi.fn(async () => {
      expect(wakeMock).toHaveBeenCalledWith('Ubuntu')
      return { useRealCodexHome: false }
    })
    await prepareAiVaultSessionResume(
      {
        agent: 'claude',
        sessionId: 'sess-1',
        filePath: String.raw`\\wsl.localhost\Ubuntu\home\qa\session.jsonl`,
        codexHome: null,
        executionHostId: 'local'
      },
      { prepareSessionResume }
    )
    expect(prepareSessionResume).toHaveBeenCalledOnce()
  } finally {
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  }
})
