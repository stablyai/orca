import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_BRACKETED_PASTE_END } from '../../shared/agent-prompt-injection'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'
import { acknowledgeAgentPromptSubmit } from './orca-runtime-test-mocks.spec'

const CODEX_COMPOSER_READY_BYTES = '\x1b[?2004h\x1b[?1049h\x1b[1m›\x1b[0m'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-verification',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-verification',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

describe('Codex composer wait before prompt paste', () => {
  afterEach(() => {
    agentSessionPtyWriteGate.detachRecordLookup()
  })

  it('waits for Codex composer readiness before writing prompt bytes', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        (nextRuntime, data) => {
          if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
            setTimeout(
              () => nextRuntime.onPtyData('pty-prompt', '\x1b[?25hcomposer redraw', Date.now()),
              1
            )
          }
          acknowledgeAgentPromptSubmit(nextRuntime, 'pty-prompt', data)
        },
        'codex'
      )

      const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'review this change')
      await vi.advanceTimersByTimeAsync(100)
      expect(writes).toEqual([])

      runtime.onPtyData('pty-prompt', '\x1b[?20', Date.now())
      await vi.advanceTimersByTimeAsync(1)
      expect(writes).toEqual([])
      runtime.onPtyData('pty-prompt', CODEX_COMPOSER_READY_BYTES.slice(5), Date.now())
      await vi.advanceTimersByTimeAsync(1)
      expect(writes.join('')).toContain('review this change')

      await vi.advanceTimersByTimeAsync(1_500)
      await sendPromise
      expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails a Codex prompt without writing when composer readiness times out', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        () => undefined,
        'codex'
      )

      const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'review this change')
      const rejection = expect(sendPromise).rejects.toThrow('agent_composer_not_ready')
      await vi.advanceTimersByTimeAsync(20_000)

      await rejection
      expect(writes).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails a Codex composer wait immediately when its PTY exits', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        () => undefined,
        'codex'
      )
      let failure: unknown
      const sendPromise = runtime
        .sendTerminalAgentPrompt(handle, 'review this change')
        .catch((error: unknown) => {
          failure = error
        })

      runtime.onPtyExit('pty-prompt', 7)
      await vi.advanceTimersByTimeAsync(1)

      expect(failure).toMatchObject({ message: 'terminal_exited' })
      expect(writes).toEqual([])
      await sendPromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('revalidates the PTY generation after Codex composer readiness', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      () => undefined,
      'codex'
    )

    const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'review this change')
    const rejection = expect(sendPromise).rejects.toThrow('terminal_exited')
    runtime.onPtyData('pty-prompt', CODEX_COMPOSER_READY_BYTES, Date.now())
    runtime.onPtyExit('pty-prompt', 7)

    await rejection
    expect(writes).toEqual([])
  })

  it('refuses a native-owned Codex pane before waiting for a composer', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        () => undefined,
        'codex'
      )
      const record = agentSessionRecordFixture(agentSessionLeaseFixture({ runtimeKind: 'native' }))
      agentSessionPtyWriteGate.attachRecordLookup((sessionId) =>
        sessionId === record.sessionId ? record : null
      )
      agentSessionPtyWriteGate.bindPty('pty-prompt', record.sessionId)

      let failure: unknown
      const pending = runtime
        .sendTerminalAgentPrompt(handle, 'review this change')
        .catch((error) => {
          failure = error
        })
      await vi.advanceTimersByTimeAsync(1)

      expect(failure).toMatchObject({
        name: 'AgentSessionPtyWriteRefusedError',
        refusal: expect.objectContaining({
          code: 'agent_session_conflict',
          ownerRuntimeKind: 'native'
        })
      })
      expect(writes).toEqual([])
      await vi.advanceTimersByTimeAsync(20_000)
      expect(failure).toMatchObject({
        name: 'AgentSessionPtyWriteRefusedError',
        refusal: expect.objectContaining({ code: 'agent_session_conflict' })
      })
      expect(writes).toEqual([])
      await pending
    } finally {
      vi.useRealTimers()
    }
  })
})
