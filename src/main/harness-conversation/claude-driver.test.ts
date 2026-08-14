import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessConversationDriverSink } from './driver'

const queryMock = vi.hoisted(() => vi.fn())

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }))

import { ClaudeConversationDriver } from './claude-driver'

const sink = {
  emit: vi.fn(),
  setProviderSessionId: vi.fn(),
  setConfiguration: vi.fn(),
  setContext: vi.fn(),
  setSubagents: vi.fn(),
  setTranscriptPath: vi.fn()
} satisfies HarnessConversationDriverSink

beforeEach(() => {
  vi.clearAllMocks()
  queryMock.mockReturnValue({
    initializationResult: () => new Promise(() => undefined),
    async *[Symbol.asyncIterator]() {}
  })
})

describe('ClaudeConversationDriver', () => {
  it('uses Orca’s resolved Claude binary and existing yolo mode', () => {
    new ClaudeConversationDriver({
      cwd: '/repo',
      providerSessionId: null,
      forkFromProviderSessionId: null,
      command: '/opt/bin/claude',
      commandArgs: [],
      permissionMode: 'yolo',
      env: {},
      sink
    })

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          pathToClaudeCodeExecutable: '/opt/bin/claude',
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          canUseTool: undefined
        })
      })
    )
    expect(queryMock.mock.calls[0]?.[0].options).not.toHaveProperty('includeHookEvents')
  })
})
