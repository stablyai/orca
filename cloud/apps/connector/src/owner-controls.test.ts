import { describe, expect, it } from 'vitest'
import { answerDeliveryId } from './owner-controls.js'

describe('owner answers', () => {
  it('keeps two sources’ answers to the same conversation and prompt ids apart', () => {
    const externalId = 'T1:C1:1.0:U1'
    expect(answerDeliveryId({ source: 'slack', externalId }, 'p1')).not.toBe(
      answerDeliveryId({ source: 'discord', externalId }, 'p1')
    )
  })
})
