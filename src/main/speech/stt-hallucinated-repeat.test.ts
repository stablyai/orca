import { describe, expect, it } from 'vitest'
import { collapseHallucinatedRepeats } from './stt-hallucinated-repeat'

const sentence = 'Make sure everything is working and just push.'

describe('collapseHallucinatedRepeats', () => {
  it('collapses three copies of one sentence to a single copy', () => {
    const text = `${sentence} ${sentence} ${sentence}`

    expect(collapseHallucinatedRepeats(text)).toBe(sentence)
  })

  it('collapses three copies plus a truncated prefix of the same sentence', () => {
    const text = `${sentence} ${sentence} ${sentence} Make sure`

    expect(collapseHallucinatedRepeats(text)).toBe(sentence)
  })

  it('keeps a sentence the speaker said twice', () => {
    const text = `${sentence} ${sentence}`

    expect(collapseHallucinatedRepeats(text)).toBe(text)
  })

  it('keeps distinct sentences', () => {
    const text = 'Check the build. Then push the branch.'

    expect(collapseHallucinatedRepeats(text)).toBe(text)
  })
})
