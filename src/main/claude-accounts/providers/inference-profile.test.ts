import { describe, expect, it } from 'vitest'
import { deriveInferenceProfilePrefix } from './inference-profile'

describe('deriveInferenceProfilePrefix', () => {
  it('us- regions → "us."', () => {
    expect(deriveInferenceProfilePrefix('us-east-1')).toBe('us.')
    expect(deriveInferenceProfilePrefix('us-west-2')).toBe('us.')
  })

  it('eu- regions → "eu."', () => {
    expect(deriveInferenceProfilePrefix('eu-west-1')).toBe('eu.')
    expect(deriveInferenceProfilePrefix('eu-central-1')).toBe('eu.')
  })

  it('ap- regions → "apac."', () => {
    expect(deriveInferenceProfilePrefix('ap-southeast-2')).toBe('apac.')
    expect(deriveInferenceProfilePrefix('ap-northeast-1')).toBe('apac.')
  })

  it('jp- prefix tolerated → "jp."', () => {
    expect(deriveInferenceProfilePrefix('jp-northeast-1')).toBe('jp.')
  })

  it('"global" → "global."', () => {
    expect(deriveInferenceProfilePrefix('global')).toBe('global.')
  })

  it('unknown region → empty string (no prefix; caller treats as no-op)', () => {
    expect(deriveInferenceProfilePrefix('ca-central-1')).toBe('')
    expect(deriveInferenceProfilePrefix('')).toBe('')
  })
})
