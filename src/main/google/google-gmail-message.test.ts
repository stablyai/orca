import { expect, it } from 'vitest'
import { bodyText, type Part } from './google-gmail-message'

const textPart = (mimeType: string, text: string): Part => ({
  mimeType,
  body: { data: Buffer.from(text).toString('base64url') }
})

it('keeps mixed body sections while selecting each nested alternative and excluding attachments', () => {
  const message: Part = {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          textPart('text/plain', 'First section'),
          {
            mimeType: 'multipart/related',
            parts: [textPart('text/html', '<p>Alternate first section</p>')]
          }
        ]
      },
      {
        mimeType: 'multipart/alternative',
        parts: [
          {
            mimeType: 'multipart/related',
            parts: [textPart('text/html', '<p>Second section</p>')]
          }
        ]
      },
      { ...textPart('text/plain', 'Attached note'), filename: 'note.txt' },
      {
        ...textPart('text/html', '<p>Attached document</p>'),
        filename: '',
        headers: [{ name: 'Content-Disposition', value: 'ATTACHMENT; filename=""' }]
      },
      {
        mimeType: 'multipart/alternative',
        headers: [{ name: 'Content-Disposition', value: 'Attachment; filename=""' }],
        parts: [textPart('text/plain', 'Attached MIME body')]
      }
    ]
  }
  expect(bodyText(message)).toBe('First section\nSecond section')
})

it('ignores disposition comments when excluding attachments without changing related roots', () => {
  const body = textPart('text/plain', 'Body')
  for (const disposition of [
    '(export) attachment',
    '(export (archive)) ATTACHMENT (payload); filename=""',
    '(escaped \\( label) attachment',
    'attachment(export)',
    'attachment (unterminated',
    'attachment; filename="" (unterminated'
  ]) {
    const attached: Part = {
      ...textPart('text/plain', 'Attached note'),
      filename: '',
      headers: [{ name: 'Content-Disposition', value: disposition }]
    }
    expect(bodyText({ mimeType: 'multipart/alternative', parts: [body, attached] })).toBe('Body')
    expect(bodyText({ mimeType: 'multipart/mixed', parts: [body, attached] })).toBe('Body')
    expect(bodyText({ mimeType: 'multipart/related', parts: [attached, body] })).toBe(
      'Attached note'
    )
  }
  expect(
    bodyText({
      mimeType: 'multipart/alternative',
      parts: [
        body,
        {
          ...textPart('text/plain', 'Inline note'),
          headers: [
            { name: 'Content-Disposition', value: '(export) inline; filename="attachment (note)"' }
          ]
        }
      ]
    })
  ).toBe('Inline note')
})

it('does not let related CID resources replace the preferred plain body', () => {
  const root: Part = {
    ...textPart('text/html', '<p>HTML body</p>'),
    headers: [{ name: 'Content-ID', value: '<body>' }]
  }
  const resource: Part = {
    ...textPart('text/plain', 'Inline resource'),
    headers: [{ name: 'Content-ID', value: '<details>' }]
  }
  const related: Part = { mimeType: 'multipart/related', parts: [root, resource] }
  expect(
    bodyText({
      mimeType: 'multipart/alternative',
      parts: [textPart('text/plain', 'Complete plain body'), related]
    })
  ).toBe('Complete plain body')
  expect(
    bodyText({
      ...related,
      headers: [{ name: 'Content-Type', value: 'multipart/related; start="<body>"' }],
      parts: [resource, root]
    })
  ).toBe('HTML body')
  expect(
    bodyText({
      ...related,
      headers: [
        {
          name: 'Content-Type',
          value: 'multipart/related; name="quoted = value"; start \t= \t"<body>"'
        }
      ],
      parts: [{ mimeType: 'image/png' }, root]
    })
  ).toBe('HTML body')
  expect(
    bodyText({
      ...related,
      headers: [
        {
          name: 'Content-Type',
          value: 'multipart/related; boundary="a; start = <decoy>"; start \t=\r\n "<body>"'
        }
      ],
      parts: [{ mimeType: 'image/png' }, root]
    })
  ).toBe('HTML body')
  expect(
    bodyText({
      ...related,
      headers: [
        {
          name: 'Content-Type',
          value: String.raw`multipart (type)/related (outer (nested\) note)); name="literal (quoted) = value"; start (root) = "<body>"`
        }
      ],
      parts: [{ mimeType: 'image/png' }, root]
    })
  ).toBe('HTML body')
  expect(
    bodyText({
      ...related,
      parts: [
        {
          ...root,
          filename: 'body.html',
          headers: [{ name: 'Content-Disposition', value: 'attachment' }]
        },
        resource
      ]
    })
  ).toBe('HTML body')
})

it('pairs equivalent mixed plain and HTML siblings without removing independent repeated sections', () => {
  const message: Part = {
    mimeType: 'multipart/mixed',
    parts: [
      textPart('text/html', '<p>Daily&nbsp;status</p>'),
      { ...textPart('text/plain', 'Attached note'), filename: 'note.txt' },
      textPart('text/plain', 'Daily\tstatus'),
      textPart('text/plain', 'Repeated plain section'),
      textPart('text/html', '<p>Repeated plain section</p>'),
      textPart('text/plain', 'Repeated plain section'),
      textPart('text/html', '<p>Independent HTML section</p>'),
      textPart('text/html', '<p>Independent HTML section</p>'),
      {
        mimeType: 'multipart/mixed',
        parts: [
          textPart('text/plain', 'Nested section'),
          textPart('text/html', '<p>Nested section</p>')
        ]
      },
      {
        mimeType: 'multipart/mixed',
        parts: [
          textPart('text/plain', 'Nested section'),
          textPart('text/html', '<p>Nested section</p>')
        ]
      }
    ]
  }
  expect(bodyText(message)).toBe(
    'Daily\tstatus\nRepeated plain section\nRepeated plain section\nIndependent HTML section\nIndependent HTML section\nNested section\nNested section'
  )
  const short = textPart('text/plain', 'Status')
  for (const exactText of ['Status update', 'Status\tupdate']) {
    const exact = textPart('text/plain', exactText)
    const html = textPart('text/html', '<p>Status update</p>')
    for (const representation of [html, { mimeType: 'multipart/related', parts: [html] }]) {
      expect(bodyText({ mimeType: 'multipart/mixed', parts: [short, representation, exact] })).toBe(
        `Status\n${exactText}`
      )
      expect(bodyText({ mimeType: 'multipart/mixed', parts: [exact, representation, short] })).toBe(
        `${exactText}\nStatus`
      )
    }
  }
  const report = 'Nightly report\nAll checks passed. See the chart below.'
  expect(
    bodyText({
      mimeType: 'multipart/mixed',
      parts: [
        textPart('text/plain', report),
        textPart(
          'text/html',
          `<p>Nightly report</p><p>All checks passed. See the chart below.</p><img src="data:image/png;base64,${'A'.repeat(200_000)}">`
        )
      ]
    })
  ).toBe(report)
})

it('pairs a related root with its adjacent plain representation while excluding its resources', () => {
  const plain = textPart('text/plain', 'Build 42 passed.')
  const html = {
    ...textPart('text/html', '<p>Build 42 passed.</p>'),
    headers: [{ name: 'Content-ID', value: '<body>' }]
  }
  const related: Part = {
    mimeType: 'multipart/related',
    headers: [{ name: 'Content-Type', value: 'multipart/related; start="<body>"' }],
    parts: [textPart('text/plain', 'A resource, not the body'), html, { mimeType: 'image/png' }]
  }
  expect(bodyText({ mimeType: 'multipart/mixed', parts: [plain, related] })).toBe(
    'Build 42 passed.'
  )
  expect(bodyText({ mimeType: 'multipart/mixed', parts: [related, plain] })).toBe(
    'Build 42 passed.'
  )
  expect(bodyText({ mimeType: 'multipart/mixed', parts: [plain, related, plain] })).toBe(
    'Build 42 passed.\nBuild 42 passed.'
  )
})

it('keeps a richer HTML representation once when its complete adjacent plain body is included', () => {
  const plain = textPart('text/plain', 'Build 42 passed.')
  const html = textPart(
    'text/html',
    '<div><header>Nightly reports</header></div><div><nav>History and account settings</nav></div><p>Build 42 passed.</p><div><footer>Unsubscribe or read the legal terms for automated build notifications.</footer></div>'
  )
  const expected =
    'Nightly reports\nHistory and account settings\nBuild 42 passed.\nUnsubscribe or read the legal terms for automated build notifications.'
  expect(bodyText({ mimeType: 'multipart/mixed', parts: [plain, html] })).toBe(expected)
  expect(bodyText({ mimeType: 'multipart/mixed', parts: [html, plain] })).toBe(expected)
  expect(bodyText({ mimeType: 'multipart/mixed', parts: [plain, html, plain] })).toBe(
    `${expected}\nBuild 42 passed.`
  )
  expect(
    bodyText({
      mimeType: 'multipart/mixed',
      parts: [{ mimeType: 'multipart/alternative', parts: [plain] }, html]
    })
  ).toBe(`Build 42 passed.\n${expected}`)
  for (const [plainText, htmlText] of [
    ['Build', 'ReBuild'],
    ['pass', 'passes'],
    ['भारत', 'अभारत']
  ]) {
    expect(
      bodyText({
        mimeType: 'multipart/mixed',
        parts: [textPart('text/plain', plainText), textPart('text/html', `<p>${htmlText}</p>`)]
      })
    ).toBe(`${plainText}\n${htmlText}`)
  }
})

it('finds a complete body after an earlier occurrence inside another word', () => {
  const plain = textPart('text/plain', 'Approved')
  const html = textPart('text/html', '<p>PreApproved policies</p><p>Approved</p><p>Footer</p>')
  const expected = 'PreApproved policies\nApproved\nFooter'
  expect(bodyText({ mimeType: 'multipart/mixed', parts: [plain, html] })).toBe(expected)
  expect(bodyText({ mimeType: 'multipart/mixed', parts: [html, plain] })).toBe(expected)
  expect(
    bodyText({
      mimeType: 'multipart/mixed',
      parts: [textPart('text/plain', 'a-a'), textPart('text/html', '<p>xa-a-a</p>')]
    })
  ).toBe('xa-a-a')
})

it('keeps independent plain text when HTML joins its word with Unicode name characters', () => {
  for (const [plain, html] of [
    ['भारत', 'अ\u200dभारत'],
    ['भारत', 'अ\u200cभारत'],
    ['भारत', 'भारत\u200dअ'],
    ['भारत', 'भारत\u200cअ'],
    ['Build', '𐐀Build'],
    ['Build', 'Build𐐀'],
    ['Build', '\u0301Build'],
    ['a'.repeat(64_000), 'a'.repeat(128_000)]
  ]) {
    const parts = [textPart('text/plain', plain), textPart('text/html', `<p>${html}</p>`)]
    expect(bodyText({ mimeType: 'multipart/mixed', parts })).toBe(`${plain}\n${html}`)
    expect(bodyText({ mimeType: 'multipart/mixed', parts: parts.toReversed() })).toBe(
      `${html}\n${plain}`
    )
  }
})

it('keeps explicit groups independent when a related container selects their single text leaf', () => {
  for (const mimeType of ['multipart/mixed', 'multipart/alternative']) {
    const root = {
      mimeType,
      headers: [{ name: 'Content-ID', value: '<body>' }],
      parts: [textPart('text/html', '<p>Notice</p>')]
    }
    const plain = textPart('text/plain', 'Notice')
    const related = {
      mimeType: 'multipart/related',
      headers: [{ name: 'Content-Type', value: 'multipart/related; start="<body>"' }],
      parts: [textPart('text/html', '<p>Resource</p>'), root]
    }
    expect(bodyText({ mimeType: 'multipart/mixed', parts: [plain, related] })).toBe(
      'Notice\nNotice'
    )
    expect(bodyText({ mimeType: 'multipart/mixed', parts: [related, plain] })).toBe(
      'Notice\nNotice'
    )
  }
})

it('keeps equivalent text in independently grouped mixed sections', () => {
  expect(
    bodyText({
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [textPart('text/plain', 'Notice'), textPart('text/html', '<p>Notice</p>')]
        },
        { mimeType: 'multipart/alternative', parts: [textPart('text/html', '<p>Notice</p>')] },
        { mimeType: 'multipart/mixed', parts: [textPart('text/plain', 'Notice')] },
        { mimeType: 'multipart/mixed', parts: [textPart('text/html', '<p>Notice</p>')] }
      ]
    })
  ).toBe('Notice\nNotice\nNotice\nNotice')
})

it('keeps the order of equal direct sections separated by another visible body', () => {
  expect(
    bodyText({
      mimeType: 'multipart/mixed',
      parts: [
        textPart('text/html', '<p>Notice</p>'),
        textPart('text/plain', 'Intervening section'),
        textPart('text/plain', 'Notice')
      ]
    })
  ).toBe('Notice\nIntervening section\nNotice')
})

it('matches commented related content IDs without changing their case or throwing on malformed comments', () => {
  const first = textPart('text/plain', 'Implicit root')
  const root = {
    ...textPart('text/html', '<p>Selected root</p>'),
    headers: [
      { name: 'Content-ID', value: '(before) <Body@example.test> (outer (nested\\) note))' }
    ]
  }
  const malformed = {
    ...textPart('text/plain', 'Malformed resource'),
    headers: [{ name: 'Content-ID', value: '<Body@example.test> (unterminated' }]
  }
  const related: Part = {
    mimeType: 'multipart/related',
    headers: [{ name: 'Content-Type', value: 'multipart/related; start="<Body@example.test>"' }],
    parts: [first, malformed, root]
  }
  expect(bodyText(related)).toBe('Selected root')
  expect(
    bodyText({
      ...related,
      headers: [{ name: 'Content-Type', value: 'multipart/related; start="<body@example.test>"' }]
    })
  ).toBe('Implicit root')
  expect(bodyText({ ...related, parts: [first, malformed] })).toBe('Implicit root')
  for (const id of ['<root@[node(tag)]>', '<"quoted(tag)"@example.test>']) {
    expect(
      bodyText({
        ...related,
        headers: [
          { name: 'Content-Type', value: `multipart/related; start=${JSON.stringify(id)}` }
        ],
        parts: [
          first,
          { ...root, headers: [{ name: 'Content-ID', value: `(before) ${id} (root)` }] }
        ]
      })
    ).toBe('Selected root')
  }
})

it('keeps empty multipart boundaries between equal mixed sections while ignoring attached groups', () => {
  for (const mimeType of ['multipart/related', 'multipart/alternative', 'multipart/mixed']) {
    const boundary: Part = { mimeType, parts: [{ mimeType: 'image/png' }] }
    const html = textPart('text/html', '<p>Notice</p>')
    const plain = textPart('text/plain', 'Notice')
    const mixed: Part = {
      mimeType: 'multipart/mixed',
      parts: [html, boundary, plain]
    }
    expect(bodyText(mixed)).toBe('Notice\nNotice')
    expect(
      bodyText({
        ...mixed,
        parts: [
          html,
          { ...boundary, headers: [{ name: 'Content-Disposition', value: 'attachment' }] },
          plain
        ]
      })
    ).toBe('Notice')
  }
})

it('prefers readable alternatives when a later body is only available as an attachment ID', () => {
  const unavailable: Part = { mimeType: 'text/plain', body: { attachmentId: 'remote-body' } }
  const available = textPart('text/plain', 'Readable plain body')
  const alternative = (parts: Part[]): Part => ({ mimeType: 'multipart/alternative', parts })
  expect(bodyText(alternative([available, unavailable]))).toBe('Readable plain body')
  expect(
    bodyText(alternative([textPart('text/html', '<p>Readable HTML body</p>'), unavailable]))
  ).toBe('Readable HTML body')
  expect(
    bodyText(
      alternative([
        available,
        { mimeType: 'multipart/mixed', parts: [textPart('text/plain', 'Partial'), unavailable] }
      ])
    )
  ).toBe('Readable plain body')
  expect(bodyText(alternative([available, { mimeType: 'multipart/mixed', parts: [] }]))).toBe(
    'Readable plain body'
  )
  expect(bodyText(alternative([available, textPart('text/plain', '')]))).toBe('')
  expect(
    bodyText(
      alternative([
        available,
        {
          mimeType: 'text/plain',
          body: {
            data: Buffer.from('Last readable plain body').toString('base64url'),
            attachmentId: 'also-present'
          }
        }
      ])
    )
  ).toBe('Last readable plain body')
})
