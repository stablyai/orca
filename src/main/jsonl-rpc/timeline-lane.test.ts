import { afterEach, expect, it, vi } from 'vitest'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  SESSION,
  GENERATION,
  NAMESPACE
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { JsonlRpcTimelineLane } from './timeline-lane'

const lanes: JsonlRpcTimelineLane[] = []
afterEach(async () => {
  lanes.splice(0).forEach((lane) => lane.dispose())
  await closeProviderTimelineRigs()
})

it('keeps reentrant callbacks behind the complete received batch and saves each once', async () => {
  const rig = await openProviderTimelineRig({ agent: 'pi' })
  const onFailed = vi.fn()
  const accepted = vi.fn(() =>
    lane.apply([
      {
        type: 'item.close',
        item: 'reentrant',
        body: { kind: 'status', tone: 'info', text: 'reentrant callback' }
      }
    ])
  )
  const lane = new JsonlRpcTimelineLane({
    sink: rig.sink,
    sessionId: SESSION,
    agent: 'pi',
    generation: GENERATION,
    namespace: NAMESPACE,
    onInputAccepted: accepted,
    onFailed
  })
  lanes.push(lane)
  lane.apply([
    { type: 'turn.open', turn: 'run:1', at: 1 },
    { type: 'input.accepted', clientMessageId: 'message:1', requestedAt: 1 },
    {
      type: 'item.close',
      item: 'first',
      body: { kind: 'status', tone: 'info', text: 'received batch' }
    },
    { type: 'turn.end', at: 2, state: 'completed', outcome: 'success' }
  ])
  await lane.drained()
  expect(accepted).toHaveBeenCalledExactlyOnceWith('message:1')
  expect(onFailed).not.toHaveBeenCalled()
  const rows = await rig.rows()
  expect(rows.flatMap((row) => (row.body.kind === 'status' ? [row.body.text] : []))).toEqual([
    'received batch',
    'reentrant callback'
  ])
  expect(await rig.turns()).toMatchObject([{ state: 'completed', outcome: 'success' }])
  expect(new Set(rows.map((row) => row.itemId)).size).toBe(rows.length)
})

it('surfaces a real sink failure and releases waiters without claiming saved output', async () => {
  const rig = await openProviderTimelineRig({ agent: 'pi' })
  const onFailed = vi.fn()
  const lane = new JsonlRpcTimelineLane({
    sink: { ...rig.sink, tryAppendTransition: () => ({ accepted: false, reason: 'failed' }) },
    sessionId: SESSION,
    agent: 'pi',
    generation: GENERATION,
    namespace: NAMESPACE,
    onInputAccepted: vi.fn(),
    onFailed
  })
  lanes.push(lane)
  const waiting = lane.whenTurnLeaves('not-saved')
  lane.apply([{ type: 'turn.open', turn: 'run:1', at: 1 }])
  expect(onFailed).toHaveBeenCalledExactlyOnceWith('failed')
  await expect(waiting).resolves.toBeUndefined()
  expect(await rig.rows()).toEqual([])
})
