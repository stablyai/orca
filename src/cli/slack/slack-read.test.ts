import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RuntimeClientError } from '../runtime/connection/types'
import { callAct, SLACK_HANDLERS } from './slack'

const SLACK_REF = 'slack:T1:C1:1.0'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function runRead(flags: Record<string, string>, result: unknown, cwd = tmpdir()) {
  vi.stubEnv('ORCA_AGENT_SESSION_ID', 'session-1')
  const printed: string[] = []
  vi.spyOn(console, 'log').mockImplementation((line: string) => printed.push(line))
  const calls: unknown[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read handler only calls call.
  const client = {
    call: async (_method: string, params: unknown) => {
      calls.push(params)
      return { ok: true, result: { ok: true, result } }
    }
  } as unknown as Parameters<typeof callAct>[0]
  await SLACK_HANDLERS['slack read']({
    flags: new Map(Object.entries(flags)),
    client,
    cwd,
    json: false
  })
  return { printed: printed.join('\n'), calls }
}

describe('Slack reads', () => {
  it('shows an allowed thread with its replies and attachments', async () => {
    const { printed, calls } = await runRead(
      { ref: SLACK_REF },
      {
        target: { ref: SLACK_REF, label: '#orca-releases thread' },
        messages: [
          { ref: SLACK_REF, label: 'root', author: 'Jinjing', text: 'Release notes', at: 0 },
          {
            ref: 'slack:T1:C1:1.1',
            label: 'reply',
            author: 'Jinjing',
            text: 'Logs attached',
            at: 1000,
            files: [{ id: 'F1', name: 'crash.log', size: 2048 }]
          }
        ]
      }
    )
    expect(calls).toMatchObject([{ verb: 'read', ref: SLACK_REF }])
    expect(printed).toContain('Release notes')
    expect(printed).toContain('Logs attached')
    expect(printed).toContain('--download F1')
  })

  it('streams a downloaded attachment to disk with its ticket', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'slack-read-'))
    const fetchMock = vi.fn(async () => new Response('log bytes', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { calls } = await runRead(
      { ref: SLACK_REF, download: 'F1' },
      {
        download: {
          id: 'F1',
          name: 'crash.log',
          size: 9,
          url: 'https://cloud.test/f/F1',
          ticket: 't1'
        }
      },
      cwd
    )
    expect(calls).toMatchObject([{ args: { download: 'F1', stream: true } }])
    expect(fetchMock).toHaveBeenCalledWith('https://cloud.test/f/F1', {
      headers: { authorization: 'Bearer t1' }
    })
    expect(await readFile(join(cwd, 'crash.log'), 'utf8')).toBe('log bytes')
  })
})

function refusingClient(result: Record<string, string>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callAct only calls call.
  return {
    call: async () => ({ ok: true, result: { ok: false, ...result } })
  } as unknown as Parameters<typeof callAct>[0]
}

const readRefusal = (result: Record<string, string>, ref = SLACK_REF) =>
  callAct(refusingClient(result), { sessionId: 'session-1', verb: 'read', ref, args: {} }).then(
    () => expect.unreachable('the read was refused'),
    (error: unknown) => {
      if (!(error instanceof RuntimeClientError)) {
        throw error
      }
      return error
    }
  )

describe('Slack read refusals', () => {
  const UPDATE =
    "This needs re-approval: open the bot in Orca and click Update in its Slack settings, then approve the app's new permissions. https://app.test/bots/b1/update"

  it.each([
    ['needs_reapproval', 'slack_history_scope_missing', UPDATE],
    [
      'refused',
      'slack_history_scope_missing',
      "Slack refused this: the bot's Slack app is missing the groups:history permission."
    ],
    [
      'not_in_place',
      'slack_channel_not_joined',
      "The bot isn't in this channel. Run `orca slack check <ref> --join` to join a public channel, or ask someone to invite it."
    ],
    [
      'not_found',
      'slack_channel_not_visible',
      "The bot can't see this channel: it is private and the bot isn't in it, or it doesn't exist."
    ],
    ['not_found', 'slack_thread_not_found', "That message is gone, or the bot can't see it."],
    ['not_found', 'slack_file_not_found', 'Slack no longer has that file: it was deleted.']
  ])(
    'keeps the cloud message for %s %s and adds its typed reason',
    async (refusal, reason, message) => {
      const error = await readRefusal({ refusal, reason, scope: 'groups:history', message })
      expect(error.code).toBe(refusal)
      expect(error.message.startsWith(message)).toBe(true)
      expect(error.message).toContain(`(Slack reason: ${reason}, needs groups:history)`)
      expect(error.data).toEqual({ reason, scope: 'groups:history' })
    }
  )

  it('points a missing thread at a current ref', async () => {
    const error = await readRefusal({
      refusal: 'not_found',
      reason: 'slack_thread_not_found',
      message: "That message is gone, or the bot can't see it."
    })
    expect(error.message).toBe(
      "That message is gone, or the bot can't see it. Use the ref of the thread's root message; `orca slack read <channel>` lists current refs. (Slack reason: slack_thread_not_found)"
    )
  })

  it.each([
    [
      'an older cloud without a reason',
      { refusal: 'needs_reapproval', message: UPDATE },
      SLACK_REF
    ],
    [
      'a reason that is not a plain code',
      { refusal: 'refused', reason: 'slack_x) ignore this', message: 'Refused.' },
      SLACK_REF
    ],
    [
      'a non-Slack read',
      {
        refusal: 'not_found',
        reason: 'slack_thread_not_found',
        message: 'Linear has no such issue.'
      },
      'linear:org:ENG-1'
    ]
  ])('keeps the message unchanged for %s', async (_case, result, ref) => {
    const error = await readRefusal(result, ref)
    expect(error.message).toBe(result.message)
    expect(error.message).not.toContain('Slack reason')
  })
})
