import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ConnectorReadMessageSchema } from './action-messages.js'
import { budgetMessageParts } from './message-parts.js'
import { slackMessageParts, slackMessageText } from './slack-message-parts.js'

// Synthetic conversations.replies fixture: a person's message with another bot's reply forwarded into it.
const forwarded: unknown = JSON.parse(
  readFileSync(new URL('./test-fixtures/slack-forwarded-message.json', import.meta.url), 'utf8')
)

const file = (id: string, name = `${id}.png`) => ({ id, name, mimetype: 'image/png', size: 2048 })

describe('slack message parts', () => {
  it('reads a forwarded message as shared: who wrote it, its ref, link and words', () => {
    expect(slackMessageParts(forwarded, 'TEXAMPLE')).toEqual({
      shared: [
        {
          author: 'Sample Assistant',
          ref: 'slack:TEXAMPLE:CEXAMPLE:1700000001.100000:1700000002.200000',
          url: 'https://example.slack.com/archives/CEXAMPLE/p1700000002200000?thread_ts=1700000001.100000&cid=CEXAMPLE',
          at: 1700000002200,
          text: "The sample is ready for review."
        }
      ]
    })
  })

  it('lists files inside a share with the message’s own, keeps link previews, and words only in blocks', () => {
    const parts = slackMessageParts(
      {
        text: 'see these',
        files: [file('F1')],
        attachments: [
          {
            is_share: true,
            author_name: 'Dana',
            channel_id: 'C2',
            ts: '1700000000.000100',
            message_blocks: [
              {
                message: {
                  blocks: [
                    {
                      type: 'rich_text',
                      elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'the deploy log' }] }]
                    }
                  ],
                  files: [file('F2', 'deploy.log')]
                }
              }
            ]
          },
          { title: 'Incident 42', title_link: 'https://status.example.com/42', text: 'Resolved at 10:02' },
          { title: 'not a link', title_link: 'javascript:alert(1)' }
        ]
      },
      'T1'
    )
    expect(parts).toEqual({
      files: [{ id: 'F1', name: 'F1.png', type: 'image/png', size: 2048 }],
      shared: [
        {
          author: 'Dana',
          ref: 'slack:T1:C2:1700000000.000100:1700000000.000100',
          at: 1700000000000,
          text: 'the deploy log',
          files: [{ id: 'F2', name: 'deploy.log', type: 'image/png', size: 2048 }]
        }
      ],
      links: [{ url: 'https://status.example.com/42', title: 'Incident 42', text: 'Resolved at 10:02' }]
    })
    expect(ConnectorReadMessageSchema.safeParse({ ref: 'slack:T1:C1::1.2', label: 'x', author: 'a', text: 't', at: 1, ...parts }).success).toBe(true)
  })

  it('shortens a long share and counts shares, links and files past the limits as left out', () => {
    const parts = slackMessageParts(
      {
        files: Array.from({ length: 8 }, (_, index) => file(`F${index}`)),
        attachments: [
          ...Array.from({ length: 5 }, (_, index) => ({
            is_share: true,
            channel_id: 'C2',
            ts: `1700000000.00010${index}`,
            text: 'x'.repeat(2_500),
            files: [file(`G${index}`)]
          })),
          ...Array.from({ length: 4 }, (_, index) => ({ title_link: `https://example.com/${index}` }))
        ]
      },
      'T1'
    )
    expect(parts.shared?.map((item) => [item.text.length, item.cut, item.files?.length])).toEqual([
      [2_000, true, 1],
      [2_000, true, 1],
      [2_000, true, undefined]
    ])
    expect([parts.files?.length, parts.links?.length]).toEqual([8, 3])
    // 2 shares + 1 link past their limits, 1 file past the 10 (8 own + 2 shared) and the 2 dropped shares' files.
    expect(parts.partsLeftOut).toBe(2 + 1 + 1 + 2)
  })

  it('takes the words in blocks only when they say more than the text', () => {
    const blocks = [
      {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: 'ship it ' },
              { type: 'link', url: 'https://example.com', text: 'here' }
            ]
          }
        ]
      }
    ]
    expect(slackMessageText({ text: 'ship it', blocks })).toBe('ship it <https://example.com|here>')
    expect(slackMessageText({ text: 'something else', blocks })).toBe('something else')
  })

  it('keeps parts while they fit a budget, asker first, and counts the rest as left out', () => {
    const shared = [{ text: 'y'.repeat(100) }]
    const [first, second] = budgetMessageParts([{ id: 'a', shared }, { id: 'b', shared }], 150)
    expect(first).toEqual({ id: 'a', shared })
    expect(second).toEqual({ id: 'b', partsLeftOut: 1 })
  })
})
