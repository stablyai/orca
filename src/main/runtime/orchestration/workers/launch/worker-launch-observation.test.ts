import { describe, expect, it } from 'vitest'
import { workerStartOptionsLaunch } from './worker-launch-observation'

describe('workerStartOptionsLaunch', () => {
  it('reads the effective launch choices from start options', () => {
    expect(
      workerStartOptionsLaunch(
        JSON.stringify({
          launch: {
            requested: { agent: 'claude', model: null, effort: null },
            effective: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }
          }
        })
      )
    ).toEqual({ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' })
  })

  it('returns null when no effective choices were recorded', () => {
    expect(
      workerStartOptionsLaunch(JSON.stringify({ launch: { requested: { agent: 'claude' } } }))
    ).toBeNull()
    expect(workerStartOptionsLaunch(undefined)).toBeNull()
  })
})
