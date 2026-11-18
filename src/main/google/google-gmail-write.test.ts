import { afterEach, describe, expect, it } from 'vitest'
import {
  connectedGoogle,
  fakeGoogle,
  googleJson,
  NOW,
  type FakeRoute
} from './google-api.test-fixture'
import { splitAddresses } from '../../shared/google/email-address-list'
import { buildMimeMessage, encodeHeaderText, formatAddress } from './gmail-mime-message'
import { modifyGmail, saveGmailDraft, sendGmailDraft } from './google-gmail-write'

let cleanup = (): void => {}
afterEach(() => cleanup())

type Sent = { url: URL; method: string; body: string }

async function apiWith(routes: FakeRoute[]) {
  const google = await connectedGoogle()
  cleanup = google.cleanup
  const sent: Sent[] = []
  const recorder: FakeRoute = (url, init) => {
    if (init?.method && init.method !== 'GET') {
      sent.push({ url, method: init.method, body: String(init.body ?? '') })
    }
    return null
  }
  const fake = fakeGoogle([recorder, ...routes])
  return { api: google.client.googleApi(undefined, { http: fake.http, now: () => NOW }), sent }
}

const b64 = (text: string) => Buffer.from(text).toString('base64url')
const GMAIL = '/gmail/v1/users/me'
const UPLOAD = '/upload/gmail/v1/users/me'

/** The RFC 822 message inside a multipart upload, with its base64 body decoded. */
function uploaded(body: string): { metadata: unknown; headers: string; text: string } {
  const [, json = '', raw = ''] = body.split(/--orca-[a-z0-9]+\r\nContent-Type: [^\r]+\r\n\r\n/)
  const [headers = '', ...rest] = raw.split('\r\n\r\n')
  const textPart = rest.join('\r\n\r\n').split(/\r\n--/)[0] ?? ''
  const encoded = textPart.includes('Content-Transfer-Encoding: base64')
    ? (textPart.split('\r\n\r\n')[1] ?? '')
    : textPart
  return {
    metadata: JSON.parse(json.trim()),
    headers,
    text: Buffer.from(encoded.replace(/\r\n/g, ''), 'base64').toString('utf-8')
  }
}

const savedDraft: FakeRoute = (url) =>
  url.pathname.startsWith(`${UPLOAD}/drafts`)
    ? googleJson(200, { id: 'r-9', message: { id: 'm9', threadId: 't1' } })
    : null

const original: FakeRoute = (url) =>
  url.pathname === `${GMAIL}/messages/m1`
    ? googleJson(200, {
        id: 'm1',
        threadId: 't1',
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'Sam <sam@x.com>' },
            { name: 'To', value: 'ada@acme.dev, Lee <lee@x.com>' },
            { name: 'Cc', value: 'kim@x.com' },
            { name: 'Subject', value: 'Q3 plan' },
            { name: 'Date', value: 'Tue, 3 Nov 2026 09:00:00 -0500' },
            { name: 'Message-ID', value: '<abc@x.com>' }
          ],
          body: { data: b64('Can we meet Thursday?') }
        }
      })
    : null

describe('gmail draft', () => {
  it('saves a new draft and never sends', async () => {
    const { api, sent } = await apiWith([savedDraft])
    const view = await saveGmailDraft(api, {
      to: ['sam@x.com'],
      cc: [],
      bcc: [],
      subject: 'Q3 plan',
      body: 'Here it is.',
      attachments: [{ name: 'plan.pdf', data: Buffer.from('%PDF').toString('base64') }]
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.method).toBe('POST')
    expect(sent[0]?.url.pathname).toBe(`${UPLOAD}/drafts`)
    expect(sent[0]?.body).toContain('Content-Disposition: attachment; filename="plan.pdf"')
    expect(view).toMatchObject({
      ref: 'gmail:draft:r-9',
      kind: 'new',
      updated: false,
      to: ['sam@x.com'],
      attachments: ['plan.pdf'],
      link: 'https://mail.google.com/mail/u/ada%40acme.dev/#drafts?compose=m9'
    })
  })

  it('keeps a reply-all in its thread with threading headers, the Re: subject and everyone but me', async () => {
    const { api, sent } = await apiWith([original, savedDraft])
    const view = await saveGmailDraft(api, {
      to: [],
      cc: [],
      bcc: [],
      body: 'Thursday works.',
      replyTo: 'gmail:msg:m1',
      replyAll: true,
      attachments: []
    })
    const message = uploaded(sent[0]?.body ?? '')
    expect(message.metadata).toEqual({ message: { threadId: 't1' } })
    expect(message.headers).toContain('To: "Sam" <sam@x.com>')
    expect(message.headers).toContain('Cc: "Lee" <lee@x.com>, kim@x.com')
    expect(message.headers).toContain('Subject: Re: Q3 plan')
    expect(message.headers).toContain('In-Reply-To: <abc@x.com>')
    expect(message.headers).toContain('References: <abc@x.com>')
    expect(message.text).toContain('Thursday works.')
    expect(message.text).toContain('> Can we meet Thursday?')
    expect(view.kind).toBe('reply')
  })

  it('refuses a reply that would change the subject and fork the thread', async () => {
    const { api } = await apiWith([original])
    await expect(
      saveGmailDraft(api, {
        to: [],
        cc: [],
        bcc: [],
        subject: 'New topic',
        body: 'x',
        replyTo: 'gmail:msg:m1',
        attachments: []
      })
    ).rejects.toThrow('A reply keeps the subject "Re: Q3 plan"')
  })

  it('revises a draft keeping its recipients, thread and threading headers', async () => {
    const existing: FakeRoute = (url, init) =>
      url.pathname === `${GMAIL}/drafts/r-9` && init?.method === 'GET'
        ? googleJson(200, {
            id: 'r-9',
            message: {
              id: 'm9',
              threadId: 't1',
              payload: {
                mimeType: 'text/plain',
                headers: [
                  { name: 'To', value: 'sam@x.com' },
                  { name: 'Subject', value: 'Re: Q3 plan' },
                  { name: 'In-Reply-To', value: '<abc@x.com>' },
                  { name: 'References', value: '<abc@x.com>' }
                ],
                body: { data: b64('Long version') }
              }
            }
          })
        : null
    const { api, sent } = await apiWith([existing, savedDraft])
    const view = await saveGmailDraft(api, {
      to: [],
      cc: [],
      bcc: [],
      body: 'Short version',
      draft: 'gmail:draft:r-9',
      attachments: []
    })
    expect(sent[0]?.method).toBe('PUT')
    expect(sent[0]?.url.pathname).toBe(`${UPLOAD}/drafts/r-9`)
    const message = uploaded(sent[0]?.body ?? '')
    expect(message.metadata).toEqual({ id: 'r-9', message: { threadId: 't1' } })
    expect(message.headers).toContain('To: sam@x.com')
    expect(message.headers).toContain('In-Reply-To: <abc@x.com>')
    expect(message.text).toBe('Short version')
    expect(view).toMatchObject({ updated: true, kind: 'reply', subject: 'Re: Q3 plan' })
  })
})

describe('gmail send', () => {
  it('sends a saved draft and names who it went to', async () => {
    const { api, sent } = await apiWith([
      (url) =>
        url.pathname === `${GMAIL}/drafts/r-9`
          ? googleJson(200, {
              id: 'r-9',
              message: {
                id: 'm9',
                threadId: 't1',
                payload: {
                  headers: [
                    { name: 'To', value: 'sam@x.com' },
                    { name: 'Subject', value: 'Q3 plan' }
                  ]
                }
              }
            })
          : null,
      (url) =>
        url.pathname === `${GMAIL}/drafts/send`
          ? googleJson(200, { id: 'm10', threadId: 't1' })
          : null
    ])
    const view = await sendGmailDraft(api, 'gmail:draft:r-9')
    expect(sent).toEqual([
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ id: 'r-9' }) })
    ])
    expect(view).toMatchObject({
      messageRef: 'gmail:msg:m10',
      to: ['sam@x.com'],
      subject: 'Q3 plan'
    })
  })

  it('says a draft that is gone was already sent or deleted', async () => {
    const { api, sent } = await apiWith([
      (url) => (url.pathname === `${GMAIL}/drafts/r-9` ? googleJson(404, {}) : null)
    ])
    await expect(sendGmailDraft(api, 'gmail:draft:r-9')).rejects.toThrow('That draft is gone')
    expect(sent).toHaveLength(0)
  })
})

describe('gmail archive, label and mark-read', () => {
  it('labels threads by name, making a missing label, and archives by taking Inbox off', async () => {
    const { api, sent } = await apiWith([
      (url, init) =>
        url.pathname === `${GMAIL}/labels` && init?.method === 'GET'
          ? googleJson(200, { labels: [{ id: 'Label_1', name: 'To do', type: 'user' }] })
          : null,
      (url, init) =>
        url.pathname === `${GMAIL}/labels` && init?.method === 'POST'
          ? googleJson(200, { id: 'Label_2', name: 'Receipts' })
          : null,
      (url) => (url.pathname.endsWith('/modify') ? googleJson(200, { id: 'x' }) : null),
      (url) => (url.pathname.endsWith('/batchModify') ? new Response(null, { status: 204 }) : null)
    ])
    const view = await modifyGmail(api, {
      refs: ['gmail:thread:18c2f0a1b2c3d4e5', 'gmail:msg:m1', 'gmail:msg:m2'],
      add: ['Receipts', 'starred'],
      remove: ['to do', 'inbox']
    })
    const modify = sent.find((entry) => entry.url.pathname.endsWith('/modify'))
    expect(modify?.url.pathname).toBe(`${GMAIL}/threads/18c2f0a1b2c3d4e5/modify`)
    expect(JSON.parse(modify?.body ?? '')).toEqual({
      addLabelIds: ['Label_2', 'STARRED'],
      removeLabelIds: ['Label_1', 'INBOX']
    })
    // Messages go in one batch call.
    const batch = sent.filter((entry) => entry.url.pathname.endsWith('/batchModify'))
    expect(batch).toHaveLength(1)
    expect(JSON.parse(batch[0]?.body ?? '')).toMatchObject({ ids: ['m1', 'm2'] })
    expect(view.created).toEqual(['Receipts'])
  })

  it('refuses Trash and Spam', async () => {
    const { api, sent } = await apiWith([])
    await expect(
      modifyGmail(api, { refs: ['gmail:msg:abc'], add: ['Trash'], remove: [] })
    ).rejects.toThrow("Orca doesn't move mail to Trash")
    expect(sent).toHaveLength(0)
  })
})

describe('the mail message', () => {
  it('encodes non-ASCII names and subjects and keeps header text on one line', () => {
    expect(encodeHeaderText('Plan\r\nBcc: evil@x.com')).toBe('Plan Bcc: evil@x.com')
    expect(encodeHeaderText('Réunion')).toBe(
      `=?UTF-8?B?${Buffer.from('Réunion').toString('base64')}?=`
    )
    expect(formatAddress('José <jose@x.com>')).toBe(
      `=?UTF-8?B?${Buffer.from('José').toString('base64')}?= <jose@x.com>`
    )
    expect(() => formatAddress('Sam')).toThrow("isn't an email address")
    expect(splitAddresses('"Lee, Kim" <lk@x.com>, sam@x.com')).toEqual([
      '"Lee, Kim" <lk@x.com>',
      'sam@x.com'
    ])
    const raw = buildMimeMessage({
      to: ['sam@x.com'],
      cc: [],
      bcc: ['boss@x.com'],
      subject: 'Hi',
      body: 'a\nb',
      attachments: []
    })
    expect(raw).toContain('Bcc: boss@x.com')
    expect(raw).toContain(Buffer.from('a\r\nb').toString('base64'))
  })
})
