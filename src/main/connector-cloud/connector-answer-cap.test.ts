import { describe, expect, it } from 'vitest'
import type { ConnectorEvent } from '../../shared/connectors/connector-cloud-contract'
import { answerFor, toConnectorEvent } from './connector-event-wire'
import { capAnswer } from './connector-snapshot'
import {
  CONNECTOR_SLACK_PRESENTATION_FEATURE,
  CONNECTOR_SLACK_PRESENTATION_TEXT_FEATURE,
  CONNECTOR_SLACK_PRESENTATION_TURN_END_FEATURE,
  SlackAnswerPresentationSchema,
  SLACK_PRESENTATION_UNCONFIRMED,
  slackAnswerText
} from '../../shared/connectors/slack-answer-presentation'

const NOTE = '_… cut short here. The full answer is in Orca._'

describe('capAnswer', () => {
  it('says an answer was cut, within the limit, never splitting a character', () => {
    const capped = capAnswer('é'.repeat(5_000), 1_000)
    expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(1_000)
    expect(capped.endsWith(`\n\n${NOTE}`)).toBe(true)
    expect(capped).not.toContain('�')
  })
})

describe('capAnswer closing an open code block', () => {
  const body = 'const a = 1\n'.repeat(200)
  it.each([
    ['~~~js', '~~~'],
    ['````md', '````'],
    // A fence of the other kind inside the block is its content, and closes nothing.
    ['```js\n~~~', '```']
  ])('closes %j with %j', (opener, closing) => {
    const capped = capAnswer(`Intro\n${opener}\n${body}`, 600)
    expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(600)
    expect(capped.endsWith(`const a = 1\n${closing}\n\n${NOTE}`)).toBe(true)
  })

  it('opens no block for a line of inline code that starts with backticks', () => {
    const capped = capAnswer(`\`\`\`code\`\`\` text\n${'word '.repeat(400)}`, 600)
    expect(capped.endsWith(`word\n\n${NOTE}`)).toBe(true)
  })

  it('adds no fence after a block that already closed', () => {
    const capped = capAnswer(`\`\`\`\nx\n\`\`\`\n${'word '.repeat(400)}`, 600)
    expect(capped.endsWith(`word\n\n${NOTE}`)).toBe(true)
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

  it('does not pass unchecked values to an older Slack service after renegotiation', () => {
    const presentation = SlackAnswerPresentationSchema.parse({
      v: 1,
      text: 'Compile took longest.',
      visual: {
        kind: 'table',
        title: 'Build stages',
        source: 'Build report',
        columns: [{ label: 'Stage' }, { label: 'Time', unit: 's' }],
        rows: [
          ['Install', 14],
          ['Compile', 87]
        ]
      }
    })
    const rich = { ...reply, prose: slackAnswerText(presentation), presentation }
    expect(answerFor(rich, new Set([CONNECTOR_SLACK_PRESENTATION_FEATURE]))).toBe(rich)
    expect(answerFor(rich, new Set([CONNECTOR_SLACK_PRESENTATION_TEXT_FEATURE]))).toBe(rich)
    expect(answerFor(rich, new Set())).toEqual({
      ...reply,
      prose: SLACK_PRESENTATION_UNCONFIRMED
    })

    const ended = toConnectorEvent(
      {
        kind: 'turn-ended',
        conversation: reply.conversation,
        paneKey: 'p',
        worktreeId: 'w',
        turnId: 1,
        at: 2,
        stopReason: 'success',
        origin: 'delivery',
        lastAssistantMessage: slackAnswerText(presentation),
        presentation
      },
      new Set()
    )
    expect(ended).toMatchObject({
      lastAssistantMessage: SLACK_PRESENTATION_UNCONFIRMED,
      presentation
    })
    expect(
      answerFor(ended!, new Set([CONNECTOR_SLACK_PRESENTATION_TEXT_FEATURE]))
    ).not.toHaveProperty('presentation')
    expect(
      answerFor(
        ended!,
        new Set([
          CONNECTOR_SLACK_PRESENTATION_TEXT_FEATURE,
          CONNECTOR_SLACK_PRESENTATION_TURN_END_FEATURE
        ])
      )
    ).toMatchObject({
      turnId: 1,
      lastAssistantMessage: slackAnswerText(presentation),
      presentation
    })
    expect(answerFor(ended!, new Set())).not.toHaveProperty('presentation')
  })
})
