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

it('sends only the changed row and suppresses an unchanged snapshot', async () => {
  let rows = [row(0), row(1)]
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
    frames.length = 0
    wake()
    await Promise.resolve()
    expect(frames).toEqual([])
    rows = [rows[0], row(1, 'waiting')]
    wake()
    await Promise.resolve()
    expect(frames).toEqual([
      {
        type: 'delta',
        status: 'ok',
        order: { managedBy: [], managing: ['party-0', 'party-1'], talkingWith: [] }
      },
      {
        type: 'rows',
        section: 'managing',
        rows: [
          {
            partyKey: 'party-1',
            role: 'worker',
            label: 'worker-1',
            agentKind: 'claude',
            status: 'waiting'
          }
        ]
      },
      { type: 'complete' }
    ])
  } finally {
    stop()
  }
})
