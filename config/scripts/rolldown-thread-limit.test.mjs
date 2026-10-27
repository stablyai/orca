import { describe, expect, it } from 'vitest'
import { withRolldownThreadLimit } from './rolldown-thread-limit.mjs'

describe('withRolldownThreadLimit', () => {
  it('caps both pools on large hosts', () => {
    expect(withRolldownThreadLimit({ A: '1' }, 24)).toEqual({
      A: '1',
      ROLLDOWN_WORKER_THREADS: '8',
      RAYON_NUM_THREADS: '8'
    })
  })

  it('keeps Rolldown defaults on small hosts and explicit sizes everywhere', () => {
    expect(withRolldownThreadLimit({}, 8)).toEqual({})
    expect(withRolldownThreadLimit({ RAYON_NUM_THREADS: '2' }, 24).RAYON_NUM_THREADS).toBe('2')
  })
})
