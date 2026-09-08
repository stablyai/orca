import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionBackgroundTaskState } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredStop, type MobileStructuredStop } from './use-mobile-structured-stop'

const requestMutation = vi.fn()
vi.mock('./mobile-structured-agent-session-rpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mobile-structured-agent-session-rpc')>()),
  requestStructuredAgentSessionMutation: (args: unknown) => requestMutation(args)
}))

const MONITORING: AgentSessionBackgroundTaskState = {
  state: 'monitoring',
  tasks: [{ id: 'proc-1', kind: 'command', description: 'sleep 180' }],
  supportsTaskStop: true
}

describe('useMobileStructuredStop', () => {
  let renderer: ReactTestRenderer | null = null
  let stop: MobileStructuredStop | null = null
  const onSendError = vi.fn()

  beforeEach(() => {
    requestMutation.mockReset().mockResolvedValue({ status: 'accepted', value: {} })
    onSendError.mockReset()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    stop = null
  })

  function render(options: {
    backgroundTaskState?: AgentSessionBackgroundTaskState | null
    turnId?: string | null
    fence?: number | null
    enabled?: boolean
  }): void {
    function Harness(): null {
      stop = useMobileStructuredStop({
        client: { sendRequest: vi.fn() } as unknown as RpcClient,
        sessionId: 'session-1',
        enabled: options.enabled ?? true,
        sessionKey: 'key-1',
        stateRef: {
          current: { fence: options.fence === undefined ? 3 : options.fence, items: [] }
        },
        backgroundTaskState: options.backgroundTaskState ?? null,
        turnId: options.turnId ?? null,
        operationIdsRef: { current: new Map() },
        onSendError
      })
      return null
    }
    act(() => {
      renderer = create(createElement(Harness))
    })
  }

  describe('background terminals', () => {
    it('stops every terminal under the background scope', () => {
      render({ backgroundTaskState: MONITORING })

      act(() => stop?.stopBackgroundTask())

      expect(requestMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'agentSession.cancel',
          expectedRuntimeFence: 3,
          fields: { turnId: 'background-tasks', scope: 'background-tasks' }
        })
      )
    })

    it('targets one terminal by id', () => {
      render({ backgroundTaskState: MONITORING })

      act(() => stop?.stopBackgroundTask('proc-1'))

      expect(requestMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          fields: { turnId: 'background-tasks', scope: 'background-tasks', taskId: 'proc-1' }
        })
      )
    })

    it('surfaces the running terminals and that they can be stopped', () => {
      render({ backgroundTaskState: MONITORING })

      expect(stop?.backgroundTasks).toEqual(MONITORING.tasks)
      expect(stop?.supportsBackgroundTaskStop).toBe(true)
      expect(stop?.isMonitoringBackgroundTasks).toBe(true)
    })

    it('keeps the row read-only on a host that reports state it cannot act on', () => {
      render({ backgroundTaskState: { state: 'monitoring', tasks: MONITORING.tasks } })

      // Fail closed: no Stop control rather than one that does nothing.
      expect(stop?.supportsBackgroundTaskStop).toBe(false)
      expect(stop?.isMonitoringBackgroundTasks).toBe(true)
    })

    it('stays hidden while a turn is running, where the composer already shows Stop', () => {
      render({ backgroundTaskState: MONITORING, turnId: 'turn-1' })

      expect(stop?.isMonitoringBackgroundTasks).toBe(false)
    })

    it('reports its own failure wording instead of the turn-stop wording', () => {
      render({ backgroundTaskState: MONITORING, fence: null })

      act(() => stop?.stopBackgroundTask())

      expect(requestMutation).not.toHaveBeenCalled()
      expect(onSendError).toHaveBeenCalledWith('Background terminals not stopped')
    })

    it('treats an ack-lost stop as unconfirmed rather than failed', async () => {
      requestMutation.mockResolvedValue({ status: 'unknown' })
      render({ backgroundTaskState: MONITORING })

      await act(async () => {
        stop?.stopBackgroundTask()
        await Promise.resolve()
      })

      expect(onSendError).toHaveBeenCalledWith('Stop unconfirmed — check chat before retrying')
    })
  })

  describe('turn cancel (unchanged by the background-task path)', () => {
    it('reports Stop not sent with no running turn', () => {
      render({})

      act(() => stop?.cancel())

      expect(requestMutation).not.toHaveBeenCalled()
      expect(onSendError).toHaveBeenCalledWith('Stop not sent')
    })
  })
})
