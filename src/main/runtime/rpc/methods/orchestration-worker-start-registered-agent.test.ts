// Registered native-chat agents must start structured workers; agents without chat support retain terminal mode.

import { EVERY_AGENT_CHAT } from '../../../../shared/native-chat/every-agent-chat.test-fixture'
import { describe, expect, it } from 'vitest'
import {
  decideWorkerStartMode,
  resolveWorkerStartModeOnHost
} from './orchestration-worker-start-mode'

const STRUCTURED_PREFERENCE = {
  nativeChatProviders: { ...EVERY_AGENT_CHAT, opencode2: true }
} as const

describe('a worker for a registered native-chat agent', () => {
  it('still starts a terminal worker when the host refuses that agent here', async () => {
    const mode = decideWorkerStartMode({
      params: { agent: 'opencode' },
      settings: STRUCTURED_PREFERENCE
    })
    const host = {
      getStructuredAgentSessionCreateSupport: async () => ({
        supported: false,
        reason: 'agent' as const
      })
    }
    expect(await resolveWorkerStartModeOnHost(host, mode, 'wt-1', 'opencode')).toMatchObject({
      mode: 'terminal',
      reason: 'structured_unsupported_on_host'
    })
  })

  it('starts a terminal worker when the chat program Orca installs is missing here', async () => {
    const mode = decideWorkerStartMode({
      params: { agent: 'antigravity' },
      settings: STRUCTURED_PREFERENCE
    })
    // A desktop chat tab can offer the install; a worker cannot, so only it asks for an installed one.
    const host = {
      getStructuredAgentSessionCreateSupport: async (
        _worktree: string,
        _agent: string,
        options?: { requireInstalledChatProgram?: boolean }
      ) =>
        options?.requireInstalledChatProgram
          ? { supported: false, reason: 'chat-program' as const }
          : { supported: true }
    }
    expect(await resolveWorkerStartModeOnHost(host, mode, 'wt-1', 'antigravity')).toMatchObject({
      mode: 'terminal',
      preferred: 'structured',
      reason: 'chat_runtime_not_installed'
    })
  })
})
