import { describe, expect, it } from 'vitest'
import { mergeWorkerLaunchObservation } from './worker-launch-observation'

function launchOf(json: string): { effective: unknown; effectiveSource: unknown } {
  return JSON.parse(json).launch
}

describe('mergeWorkerLaunchObservation', () => {
  it('keeps the stored value and source when an incoming null does not replace a known value', () => {
    const stored = JSON.stringify({
      launch: {
        effective: { agent: 'codex', model: 'gpt-5', effort: null },
        effectiveSource: { agent: 'session', model: 'session', effort: 'unavailable' }
      }
    })

    const merged = launchOf(
      mergeWorkerLaunchObservation(stored, {
        effective: { model: null },
        effectiveSource: { model: 'unavailable' }
      })
    )

    expect(merged.effective).toMatchObject({ agent: 'codex', model: 'gpt-5', effort: null })
    expect(merged.effectiveSource).toMatchObject({
      agent: 'session',
      model: 'session',
      effort: 'unavailable'
    })
  })

  it('records null and unavailable when there is no earlier value to keep', () => {
    const merged = launchOf(
      mergeWorkerLaunchObservation(JSON.stringify({}), {
        effective: { model: null },
        effectiveSource: { model: 'unavailable' }
      })
    )

    expect(merged.effective).toEqual({ model: null })
    expect(merged.effectiveSource).toEqual({ model: 'unavailable' })
  })
})
