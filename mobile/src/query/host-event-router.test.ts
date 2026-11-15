import { QueryObserver } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { stubRpcClient } from '../transport/rpc/rpc-client-test-stub'
import { retainHostEventRouter } from './host-event-router'
import { createOrcaQueryClient } from './orca-query-client'

vi.mock('react-native', () => ({ AppState: {}, Platform: { OS: 'ios' } }))

const KEY = ['orca', 'host-1', 'test.rows', { exec: 'local' }, {}] as const

it('reads again after a read that was already out when the event stream reopened', async () => {
  // One client-events wire at a time; each subscribe hands the test its frames.
  const wires: ((payload: unknown) => void)[] = []
  const client = stubRpcClient({
    getLastConnectedAt: () => 1,
    subscribe: (_method, _params, onData) => {
      wires.push(onData)
      return () => {}
    }
  })
  let desktopRows = 1
  const replies: ((rows: number) => void)[] = []
  const queryClient = createOrcaQueryClient()
  const router = retainHostEventRouter(queryClient, 'host-1', client)
  wires[0]?.({ type: 'ready', subscriptionId: 'events-1' })

  const observer = new QueryObserver(queryClient, {
    queryKey: KEY,
    queryFn: () => new Promise<number>((resolve) => replies.push(resolve)),
    meta: { signal: { events: ['worktreesChanged'] } }
  })
  const stop = observer.subscribe(() => {})
  await vi.waitFor(() => expect(replies).toHaveLength(1))
  replies[0]?.(desktopRows)
  await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe(1))

  // A read goes out; the stream drops and reopens on the same connection while it is out.
  void observer.refetch()
  await vi.waitFor(() => expect(replies).toHaveLength(2))
  wires[0]?.({ type: 'end' })
  desktopRows = 2
  await vi.waitFor(() => expect(wires).toHaveLength(2))
  wires[1]?.({ type: 'ready', subscriptionId: 'events-2' })
  // The read sent before the gap answers with what the desktop had then.
  replies[1]?.(1)

  await vi.waitFor(() => expect(replies).toHaveLength(3))
  replies[2]?.(desktopRows)
  await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe(2))
  stop()
  router.release()
})
