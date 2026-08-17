import { describe, expect, it, vi } from 'vitest'
import type { HarnessConversationDriverSink } from './driver'

const captures = vi.hoisted(() => ({
  claude: vi.fn(),
  codex: vi.fn(),
  acp: vi.fn(),
  omp: vi.fn()
}))

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

vi.mock('./omp-rpc-driver', () => ({
  OmpRpcConversationDriver: class {
    constructor(options: unknown) {
      captures.omp(options)
    }
  }
}))

import { createHarnessConversationDriverFactory } from './driver-factory'

const sink = {} as HarnessConversationDriverSink

function input(agent: 'claude' | 'openclaude' | 'grok' | 'omp') {
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

  it('uses one OMP rpc-ui process with matching permission and resume flags', async () => {
    const factory = createHarnessConversationDriverFactory(() => ({
      agentDefaultArgs: { omp: '--yolo' }
    }))

    await factory({ ...input('omp'), providerSessionId: 'session-1' })

    expect(captures.omp).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['--yolo', '--resume', 'session-1', '--mode', 'rpc-ui'] })
    )

    const manual = createHarnessConversationDriverFactory(() => ({ agentDefaultArgs: { omp: '' } }))
    await manual(input('omp'))
    expect(captures.omp).toHaveBeenLastCalledWith(
      expect.objectContaining({ args: ['--approval-mode', 'always-ask', '--mode', 'rpc-ui'] })
    )
  })

  it('routes OpenClaude to the Claude SDK driver', async () => {
    const factory = createHarnessConversationDriverFactory(() => ({
      agentCmdOverrides: { openclaude: '/opt/bin/openclaude' }
    }))

    await factory(input('openclaude'))

    expect(captures.claude).toHaveBeenLastCalledWith(
      expect.objectContaining({ agent: 'openclaude', command: '/opt/bin/openclaude' })
    )
  })

  it('rejects an OMP command configured for a conflicting transport', async () => {
    const factory = createHarnessConversationDriverFactory(() => ({
      agentCmdOverrides: { omp: 'omp --mode acp' }
    }))

    await expect(factory(input('omp'))).rejects.toThrow('omp_machine_mode_conflict')
  })

  it('normalizes OMP manual approval to the UI-backed mode', async () => {
    const factory = createHarnessConversationDriverFactory(() => ({
      agentCmdOverrides: { omp: 'omp --approval-mode auto' },
      agentDefaultArgs: { omp: '' }
    }))

    await factory(input('omp'))

    expect(captures.omp).toHaveBeenLastCalledWith(
      expect.objectContaining({ args: ['--approval-mode', 'always-ask', '--mode', 'rpc-ui'] })
    )
  })
})
