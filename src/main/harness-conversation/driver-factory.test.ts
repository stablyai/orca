import { describe, expect, it, vi } from 'vitest'
import type { HarnessConversationDriverSink } from './driver'

const captures = vi.hoisted(() => ({ claude: vi.fn(), codex: vi.fn(), acp: vi.fn() }))

vi.mock('./claude-driver', () => ({
  ClaudeConversationDriver: class {
    constructor(options: unknown) {
      captures.claude(options)
    }
  }
}))

vi.mock('./codex-driver', () => ({
  CodexConversationDriver: class {
    constructor(options: unknown) {
      captures.codex(options)
    }
  }
}))

vi.mock('./acp-driver', () => ({
  AcpConversationDriver: class {
    constructor(options: unknown) {
      captures.acp(options)
    }
  }
}))

import { createHarnessConversationDriverFactory } from './driver-factory'

const sink = {} as HarnessConversationDriverSink

function input(agent: 'claude' | 'grok') {
  return {
    conversationId: 'conversation-1',
    agent,
    cwd: '/repo',
    providerSessionId: null,
    forkFromProviderSessionId: null,
    spawnToken: 'spawn-1',
    sink
  }
}

describe('createHarnessConversationDriverFactory', () => {
  it('reuses Orca yolo settings for machine drivers', async () => {
    const factory = createHarnessConversationDriverFactory(() => ({
      agentDefaultArgs: {
        claude: '--dangerously-skip-permissions',
        grok: '--permission-mode bypassPermissions'
      }
    }))

    await factory(input('claude'))
    await factory(input('grok'))

    expect(captures.claude).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: 'yolo' })
    )
    expect(captures.acp).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['--permission-mode', 'bypassPermissions', 'agent', 'stdio']
      })
    )
  })

  it('keeps manual mode manual', async () => {
    const factory = createHarnessConversationDriverFactory(() => ({
      agentDefaultArgs: { claude: '' }
    }))

    await factory(input('claude'))

    expect(captures.claude).toHaveBeenLastCalledWith(
      expect.objectContaining({ permissionMode: 'manual' })
    )
  })
})
