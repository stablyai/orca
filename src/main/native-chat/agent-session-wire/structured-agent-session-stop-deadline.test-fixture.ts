import { expect, vi } from 'vitest'
import { CLAUDE_STOP_GRACE_MS } from '../../claude/claude-request-end-wait'
import type { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import type {
  fakeClaude,
  FakeConnection
} from '../../claude/claude-structured-session-test-support'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'

export function createStoppedClaudeDeadline(deps: {
  host: () => Pick<StructuredAgentSessionHost, 'flushStreamedEvents'>
  adapter: () => Pick<ClaudeStructuredSessionAdapter, 'awaitStoppedRequestEnd'>
  claude: () => ReturnType<typeof fakeClaude>
  sessionId: string
  stop: (turnId?: string) => ReturnType<StructuredAgentSessionHost['cancel']>
  laneDrained: () => Promise<void>
}) {
  return async (
    connection: FakeConnection,
    deadline: 'interrupt' | 'request-end',
    turnId?: string
  ) => {
    await deps.host().flushStreamedEvents(deps.sessionId)
    const reachedDeadline = Promise.withResolvers<
      Awaited<ReturnType<typeof deps.stop>> | undefined
    >()
    let deadlineSettled = false
    const claude = deps.claude()
    const adapter = deps.adapter()
    const interrupt = claude.routes.interrupt
    const requestEnd = adapter.awaitStoppedRequestEnd
    const waiting = vi
      .spyOn(adapter, 'awaitStoppedRequestEnd')
      .mockImplementation((sessionId, at) => {
        const pending = requestEnd(sessionId, at)
        reachedDeadline.resolve(undefined)
        return pending.then(() => {
          deadlineSettled = true
        })
      })
    if (deadline === 'interrupt') {
      claude.routes.interrupt = (params) => {
        const pending = interrupt?.(params)
        if (!(pending instanceof Promise)) {
          throw new Error('Expected an unanswered interrupt promise')
        }
        void pending.then(
          () => {
            deadlineSettled = true
          },
          () => {
            deadlineSettled = true
          }
        )
        reachedDeadline.resolve(undefined)
        return pending
      }
    }
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    try {
      const asked = Date.now()
      const stopping = deps.stop(turnId)
      void stopping.then((result) => {
        if (!result.ok || !result.value.cancelled) {
          reachedDeadline.resolve(result)
        }
      }, reachedDeadline.reject)
      const early = await reachedDeadline.promise
      if (early !== undefined) {
        return early
      }
      await vi.advanceTimersByTimeAsync(CLAUDE_STOP_GRACE_MS - 1)
      expect(deadlineSettled).toBe(false)
      expect(connection.closed).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(deadlineSettled).toBe(true)
      const result = await stopping
      await deps.laneDrained()
      expect(Date.now() - asked).toBeLessThan(CLAUDE_STOP_GRACE_MS + 1_500)
      return result
    } finally {
      waiting.mockRestore()
      if (interrupt) {
        claude.routes.interrupt = interrupt
      }
      vi.useRealTimers()
    }
  }
}
