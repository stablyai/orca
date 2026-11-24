import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

describe('Slack read refusals', () => {
  it('explains an access refusal returned by the action service', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callAct reads only call in this refusal test.
    const client = {
      call: async () => ({
        ok: true,
        result: {
          ok: false,
          refusal: 'refused',
          reason: 'slack_history_scope_missing',
          scope: 'channels:history',
          message: 'Slack API rejected the request.'
        }
      })
    } as unknown as Parameters<typeof callAct>[0]

    await expect(
      callAct(client, { sessionId: 'session-1', verb: 'read', ref: SLACK_REF, args: {} })
    ).rejects.toMatchObject({ message: expect.stringContaining('channels:history') })
  })

  it.each([
    ['slack_channel_not_joined', /bot is not in that channel/i],
    ['slack_channel_not_visible', /couldn't find a channel this bot can read/i],
    ['slack_thread_not_found', /couldn't find that thread/i],
    ['slack_file_not_found', /couldn't find that file/i]
  ])('explains the typed %s service refusal', async (reason, message) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callAct reads only call in this refusal test.
    const client = {
      call: async () => ({
        ok: true,
        result: {
          ok: false,
          refusal: 'refused',
          reason,
          message: 'Slack API rejected the request.'
        }
      })
    } as unknown as Parameters<typeof callAct>[0]

    await expect(
      callAct(client, { sessionId: 'session-1', verb: 'read', ref: SLACK_REF, args: {} })
    ).rejects.toMatchObject({ message: expect.stringMatching(message) })
  })

  it('keeps a lookup refusal even when its channel name resembles an access error', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callAct reads only call in this refusal test.
    const client = {
      call: async () => ({
        ok: true,
        result: {
          ok: false,
          refusal: 'ambiguous',
          message: 'Choose one: #slack_missing_scope in Workspace A or Workspace B.'
        }
      })
    } as unknown as Parameters<typeof callAct>[0]

    await expect(
      callAct(client, { sessionId: 'session-1', verb: 'read', ref: SLACK_REF, args: {} })
    ).rejects.toMatchObject({
      message: 'Choose one: #slack_missing_scope in Workspace A or Workspace B.'
    })
  })

  it('keeps generic service recovery text unchanged', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callAct reads only call in this refusal test.
    const client = {
      call: async () => ({
        ok: true,
        result: {
          ok: false,
          refusal: 'needs_reapproval',
          message: 'Update the bot from this link, then try again.'
        }
      })
    } as unknown as Parameters<typeof callAct>[0]

    await expect(
      callAct(client, { sessionId: 'session-1', verb: 'read', ref: SLACK_REF, args: {} })
    ).rejects.toMatchObject({ message: 'Update the bot from this link, then try again.' })
  })

  it('keeps the original message when a non-Slack read returns a Slack reason', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callAct reads only call in this refusal test.
    const client = {
      call: async () => ({
        ok: true,
        result: {
          ok: false,
          refusal: 'refused',
          reason: 'slack_thread_not_found',
          message: 'Linear could not find that issue.'
        }
      })
    } as unknown as Parameters<typeof callAct>[0]

    await expect(
      callAct(client, { sessionId: 'session-1', verb: 'read', ref: 'linear:org:ENG-1', args: {} })
    ).rejects.toMatchObject({ message: 'Linear could not find that issue.' })
  })
})
