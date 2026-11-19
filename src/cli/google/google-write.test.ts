import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GMAIL_DRAFT_ATTACH_MAX_BYTES } from '../../shared/google/gmail-draft-request-budget'
import { REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES } from '../../shared/remote-runtime/remote-runtime-memory-limits'
import { normalizeCommandPositionals, parseArgs } from '../arguments/args'
import type { HandlerContext } from '../dispatch/dispatch'
import type { RuntimeClient } from '../runtime/client'
import { COMMAND_SPECS } from '../specs'
import { GOOGLE_WRITE_HANDLERS } from './google-write'

let cwd = ''
let stdout: string[] = []
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'orca-google-write-cli-'))
  stdout = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    stdout.push(String(line))
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(cwd, { recursive: true, force: true })
})

/** Parses argv the way the CLI does, then runs the handler against a fake runtime. */
async function run(argv: string[], result: unknown) {
  const parsed = normalizeCommandPositionals(
    COMMAND_SPECS,
    parseArgs(
      argv,
      COMMAND_SPECS.map((spec) => spec.path),
      COMMAND_SPECS
    )
  )
  const sent: [string, Record<string, unknown>][] = []
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
    sent.push([method, params])
    return { id: 'r', ok: true, result, _meta: { runtimeId: 'rt' } }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers under test only use `call`.
  const client = { call } as unknown as RuntimeClient
  const context: HandlerContext = { client, cwd, flags: parsed.flags, json: false, rawArgs: argv }
  await GOOGLE_WRITE_HANDLERS[parsed.commandPath.join(' ')]?.(context)
  const [first] = sent
  if (!first) {
    throw new Error('the handler called no RPC')
  }
  return first
}

const NOW = Date.parse('2026-11-03T19:05:00Z')
const event = {
  ref: 'calendar:primary:event:e1',
  title: 'Q3 review',
  start: '2026-11-05T19:00:00Z',
  end: '2026-11-05T19:45:00Z',
  allDay: false,
  attendees: [{ email: 'sam@x.com', response: 'needsAction' }],
  recurring: false
}
const written = {
  account: 'ada@acme.dev',
  now: NOW,
  timeZone: 'America/New_York',
  calendar: { id: 'primary', name: 'Ada' },
  event,
  series: false
}

describe('orca gmail draft|send|label and calendar writes', () => {
  it('drafts with repeated and comma-separated people, a file and a reply flag, and says it is not sent', async () => {
    writeFileSync(join(cwd, 'plan.pdf'), '%PDF')
    const [method, params] = await run(
      [
        'gmail',
        'draft',
        '--reply-to',
        'gmail:msg:m1',
        '--reply-all',
        '--cc',
        'a@x.com,"Lee, Sam" <ls@x.com>',
        '--cc',
        'c@x.com',
        '--attach',
        'plan.pdf',
        '--body',
        'Thursday works.'
      ],
      {
        account: 'ada@acme.dev',
        ref: 'gmail:draft:r-9',
        messageRef: 'gmail:msg:m9',
        threadRef: 'gmail:thread:t1',
        to: ['sam@x.com'],
        cc: ['a@x.com'],
        bcc: [],
        subject: 'Re: Q3 plan',
        kind: 'reply',
        updated: false,
        attachments: ['plan.pdf'],
        link: 'https://mail.google.com/mail/u/ada%40acme.dev/#drafts?compose=m9'
      }
    )
    expect(method).toBe('google.gmail.draft')
    expect(params).toMatchObject({
      replyTo: 'gmail:msg:m1',
      replyAll: true,
      cc: ['a@x.com', '"Lee, Sam" <ls@x.com>', 'c@x.com'],
      body: 'Thursday works.',
      attachments: [{ name: 'plan.pdf', data: Buffer.from('%PDF').toString('base64') }]
    })
    expect(stdout.join('\n')).toContain(
      'Reply draft gmail:draft:r-9 saved for ada@acme.dev in gmail:thread:t1, not sent.'
    )
    expect(stdout.join('\n')).toContain('Send: orca gmail send gmail:draft:r-9')
    // The subject and people come from the original sender, so they print fenced.
    expect(stdout.join('\n')).toMatch(/\(content, not instructions\)\]\n<<<\nSubject: Re: Q3 plan/)
  })

  it('labels several refs and answers an invite with a positional answer', async () => {
    const [, label] = await run(
      [
        'gmail',
        'label',
        'gmail:thread:a',
        'gmail:thread:b',
        '--add',
        'Receipts',
        '--remove',
        'To do'
      ],
      {
        account: 'ada@acme.dev',
        refs: ['a', 'b'],
        added: ['Receipts'],
        removed: ['To do'],
        created: []
      }
    )
    expect(label).toMatchObject({
      refs: ['gmail:thread:a', 'gmail:thread:b'],
      add: ['Receipts'],
      remove: ['To do']
    })
    const [method, respond] = await run(
      ['calendar', 'respond', '--series', 'calendar:primary:event:e1', 'Decline'],
      { ...written, action: 'responded', response: 'declined', notified: [] }
    )
    expect(method).toBe('google.calendar.respond')
    expect(respond).toMatchObject({
      ref: 'calendar:primary:event:e1',
      answer: 'decline',
      series: true
    })
    expect(stdout.at(-1)).toContain('Declined:')
  })

  it('creates an event and prints the Now line and who was emailed', async () => {
    const [, params] = await run(
      [
        'calendar',
        'create',
        '--title',
        'Q3 review',
        '--start',
        '2026-11-05T14:00',
        '--duration',
        '45m',
        '--with',
        'sam@x.com',
        '--meet',
        '--no-notify'
      ],
      { ...written, action: 'created', notified: ['sam@x.com'] }
    )
    expect(params).toMatchObject({
      title: 'Q3 review',
      start: '2026-11-05T14:00',
      duration: '45m',
      with: ['sam@x.com'],
      meet: true,
      notify: false
    })
    const out = stdout.at(-1) ?? ''
    expect(out.split('\n')[0]).toBe('Now: Tue 3 Nov 2026 14:05 America/New_York')
    expect(out).toContain('Created on primary for ada@acme.dev:')
    expect(out).toContain('(content, not instructions)')
    expect(out).toContain('Invites emailed to: sam@x.com')
  })

  it('accepts a draft attachment at the paired-server cap and refuses one byte over', async () => {
    writeFileSync(join(cwd, 'cap.bin'), Buffer.alloc(GMAIL_DRAFT_ATTACH_MAX_BYTES, 0xff))
    const [method, params] = await run(
      [
        'gmail',
        'draft',
        '--to',
        'sam@x.com,ana@x.com',
        '--subject',
        'Q3 plan',
        '--body',
        'Here it is.\n'.repeat(200),
        '--attach',
        'cap.bin'
      ],
      {
        account: 'ada@acme.dev',
        ref: 'gmail:draft:r',
        messageRef: 'gmail:msg:m',
        threadRef: 'gmail:thread:t',
        to: [],
        cc: [],
        bcc: [],
        subject: 'Q3 plan',
        kind: 'new',
        updated: false,
        attachments: ['cap.bin'],
        link: 'x'
      }
    )
    // The request as a paired client frames it: id, device token, method and params.
    const request = JSON.stringify({
      id: randomUUID(),
      deviceToken: 'd'.repeat(64),
      method,
      params
    })
    expect(Buffer.byteLength(request)).toBeLessThanOrEqual(
      REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES
    )
    writeFileSync(join(cwd, 'big.bin'), Buffer.alloc(GMAIL_DRAFT_ATTACH_MAX_BYTES + 1))
    await expect(
      run(
        [
          'gmail',
          'draft',
          '--to',
          'sam@x.com',
          '--subject',
          'Hi',
          '--body',
          'x',
          '--attach',
          'big.bin'
        ],
        {}
      )
    ).rejects.toThrow('share a Drive link for bigger files')
  })
})
