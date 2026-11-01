import { isKeyedObject } from '../bridged-parity/divergence-evidence'
import { BRIDGE_REPLY_REFUSED, rows } from './changed-bridge-outcomes'
import type { Observation, Recording } from './recording-scenario'
import type { RecordedValue } from './recording-values'

type Outcome = (observation: Observation) => Observation

function state(observation: Observation): Record<string, RecordedValue> {
  if (!isKeyedObject(observation.state)) {
    throw new Error('Missing reviewed screen state')
  }
  return observation.state
}

// Replace the reviewed golden's last effects, by name, with the page's own; any other shape fails loudly.
function lastEffects(
  observation: Observation,
  native: readonly string[],
  page: readonly [name: string, value: RecordedValue][]
): RecordedValue {
  const effects = rows(observation.effects)
  const tail = effects.slice(-native.length)
  if (JSON.stringify(tail.map((effect) => effect.name)) !== JSON.stringify(native)) {
    throw new Error(`Reviewed golden no longer ends with ${native.join(', ')}`)
  }
  return [
    ...effects.slice(0, -native.length),
    ...page.map(([name, value], index) => ({ name, ordinal: tail[index]!.ordinal ?? null, value }))
  ]
}

// Native accepts the injected { ok: true } as an empty result; the page refuses the frame, and the product shows
// that refusal instead of finishing the action. One finite expectation per producer and checkpoint.
const PAGE_REFUSAL_OUTCOMES: Readonly<Record<string, Readonly<Record<string, Outcome>>>> = {
  'matrix-tasks.item-detail-linear-linear.issuecomments-1': {
    'tk-item-detail-linear.result-absent:mounted': (observation) => ({
      ...observation,
      state: { ...state(observation), error: BRIDGE_REPLY_REFUSED, payload: { $rpc: 'null' } },
      effects: lastEffects(
        observation,
        ['detailLoading', 'detailPayload'],
        [
          ['detailError', BRIDGE_REPLY_REFUSED],
          ['detailLoading', false]
        ]
      )
    })
  },
  'matrix-tasks.item-reply-merge-linear.updateissue-1': {
    'tk-item-reply-merge.result-absent:linear-status-settled': (observation) => ({
      ...observation,
      state: { ...state(observation), error: BRIDGE_REPLY_REFUSED },
      effects: lastEffects(
        observation,
        ['items', 'mutatingStatus'],
        [
          ['error', BRIDGE_REPLY_REFUSED],
          ['mutatingStatus', false]
        ]
      )
    })
  }
}

export function pageRefusalOutcome(id: string, expected: Recording): Recording {
  const outcomes = PAGE_REFUSAL_OUTCOMES[id]
  if (!outcomes) {
    return expected
  }
  const missing = Object.keys(outcomes).filter(
    (checkpoint) => !expected.checkpoints.some((entry) => entry.id === checkpoint)
  )
  if (missing.length) {
    throw new Error(`Declared page outcome has no reviewed checkpoint: ${missing.join(', ')}`)
  }
  return {
    ...expected,
    checkpoints: expected.checkpoints.map((checkpoint) => {
      const outcome = outcomes[checkpoint.id]
      return outcome ? { ...checkpoint, observation: outcome(checkpoint.observation) } : checkpoint
    })
  }
}
