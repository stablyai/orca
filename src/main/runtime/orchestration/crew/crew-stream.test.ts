import { expect, it } from 'vitest'
import type {
  OrchestrationCrewFrame,
  OrchestrationCrewRow,
  OrchestrationCrewSnapshot
} from '../../../../shared/orchestration/orchestration-crew'
import { subscribeCrew } from './crew-stream'

const row = (index: number, status = 'working'): OrchestrationCrewRow => ({
  partyKey: `party-${index}`,
  role: 'worker',
  label: `worker-${index}`,
  agentKind: 'claude',
  status
})

it('sends one changed row of a hundred as a delta, and nothing when nothing changed', async () => {
  let rows = Array.from({ length: 100 }, (_, index) => row(index))
  const snapshot = (): OrchestrationCrewSnapshot => ({
    status: 'ok',
    sections: { managedBy: [], managing: rows, talkingWith: [] }
  })
  let wake = () => {}
  const frames: OrchestrationCrewFrame[] = []
  const stop = subscribeCrew(
    snapshot,
    (listener) => {
      wake = listener
      return () => {}
    },
    (frame) => frames.push(frame),
    'rows',
    true
  )
  try {
    expect(frames).toHaveLength(102)
    frames.length = 0
    wake()
    await Promise.resolve()
    expect(frames).toEqual([])
    rows = rows.map((entry, index) => (index === 42 ? row(42, 'waiting') : entry))
    wake()
    await Promise.resolve()
    expect(frames.map((frame) => frame.type)).toEqual(['delta', 'rows', 'complete'])
    expect(frames[1]).toEqual({ type: 'rows', section: 'managing', rows: [row(42, 'waiting')] })
  } finally {
    stop()
  }
})
