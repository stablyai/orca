import { describe, expect, it } from 'vitest'
import { hostedProgressLine } from './hosted-sandbox-recipe'

describe('hostedProgressLine', () => {
  it('names a held environment by id (ENV-BUILD-CHURN), and nothing else gets through', () => {
    expect(hostedProgressLine({ phase: 'environment-held', message: 'env_0123abcd' })).toBe(
      '[orca-cloud] environment-held env_0123abcd\n'
    )
    expect(hostedProgressLine({ phase: 'environment-held', message: 'x y\nz' })).toBe(
      '[orca-cloud] environment-held\n'
    )
    expect(hostedProgressLine({ phase: 'cloning', percent: 40, message: 'checkout' })).toBe(
      '[orca-cloud] clone-progress 40 checkout\n'
    )
  })
})
