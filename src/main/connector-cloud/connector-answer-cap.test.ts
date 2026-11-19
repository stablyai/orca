import { describe, expect, it } from 'vitest'
import type { ConnectorEvent } from '../../shared/connectors/connector-cloud-contract'
import { answerFor } from './connector-event-wire'
import { capAnswer } from './connector-snapshot'

const NOTE = '_… cut short here. The full answer is in Orca._'

describe('capAnswer', () => {
  it('leaves an answer within the limit as written', () => {
    expect(capAnswer('All good.', 8 * 1024)).toBe('All good.')
  })

  it('says an answer was cut, within the limit, never splitting a character', () => {
    const capped = capAnswer('é'.repeat(5_000), 1_000)
    expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(1_000)
    expect(capped.endsWith(`\n\n${NOTE}`)).toBe(true)
    expect(capped).not.toContain('�')
  })

  it('ends at a line break near the limit, and closes a code block the cut left open', () => {
    const text = `Intro\n\`\`\`ts\n${'const a = 1\n'.repeat(200)}`
    const capped = capAnswer(text, 600)
    expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(600)
    expect(capped.endsWith(`const a = 1\n\`\`\`\n\n${NOTE}`)).toBe(true)
  })
})

describe('answerFor', () => {
  const reply: ConnectorEvent = {
    kind: 'reply',
    conversation: { source: 'slack', externalId: 'T1:C1:1.0' },
    deliveryIds: ['d1'],
    answerDeliveryId: 'd1',
    outcome: 'answered',
    prose: 'a'.repeat(20_000)
  }

  it('cuts a reply’s prose to 8 KB only for a cloud that doesn’t list answers.long', () => {
    expect(answerFor(reply, new Set(['answers.long']))).toBe(reply)
    const cut = answerFor(reply, new Set())
    expect(cut).toMatchObject({ kind: 'reply', answerDeliveryId: 'd1' })
    expect(cut.kind === 'reply' && cut.prose).toBe(
      `${'a'.repeat(8_137)}\n\n_… cut short here. The full answer is in Orca._`
    )
  })

  it('hands back the same event when nothing is over the cap', () => {
    const short: ConnectorEvent = { ...reply, prose: 'ok' }
    expect(answerFor(short, new Set())).toBe(short)
  })
})
