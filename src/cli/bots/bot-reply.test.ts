import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCA_SCRUB_SAFE_PANE_ENV } from '../../shared/agent-hook-listener/transport/agent-hook-scrub-safe-env'
import { ORCA_AGENT_SESSION_ID_ENV } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { CONNECTOR_REPLY_UNAVAILABLE } from '../../shared/rpc-contract/connectors/connector-params'
import { REPEATED_FLAG_SEPARATOR } from '../arguments/args'
import { RuntimeClientError } from '../runtime/connection/types'
import { BOT_REPLY_HANDLERS } from './bot-reply'

function refusingClient(code: string) {
  return {
    call: async (): Promise<never> => {
      throw new RuntimeClientError(code, code)
    }
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('orca bot reply', () => {
  it('replies from a native chat by its session id, which has no pane', async () => {
    vi.stubEnv('ORCA_PANE_KEY', '')
    vi.stubEnv(ORCA_SCRUB_SAFE_PANE_ENV, '')
    vi.stubEnv(ORCA_AGENT_SESSION_ID_ENV, 'session-1')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const call = vi.fn(async () => ({ status: 'posted', messageId: 'm1' }))

    await BOT_REPLY_HANDLERS['bot reply']({
      flags: new Map([['text', 'done']]),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler uses only client.call, supplied here.
      client: { call } as never,
      cwd: '/',
      json: true
    })

    expect(call).toHaveBeenCalledWith(
      'connector.reply',
      { sessionId: 'session-1', replyId: expect.any(String), text: 'done' },
      expect.anything()
    )
  })

  it('refuses words that are only blanks instead of sending nothing', async () => {
    vi.stubEnv(ORCA_AGENT_SESSION_ID_ENV, 'session-1')
    const call = vi.fn()
    await expect(
      BOT_REPLY_HANDLERS['bot reply']({
        flags: new Map([['text', '   ']]),
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler uses only client.call, supplied here.
        client: { call } as never,
        cwd: '/',
        json: true
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })

  it.each([
    ['bot_chat_reply', 'this is your Chat'],
    ['not_a_cloud_conversation', 'Your Home chat has none'],
    ['not_this_bots_conversation', "doesn't belong to this bot"]
  ])('says plainly that %s posted nothing', async (code, says) => {
    vi.stubEnv('ORCA_PANE_KEY', '')
    vi.stubEnv(ORCA_SCRUB_SAFE_PANE_ENV, '')
    vi.stubEnv(ORCA_AGENT_SESSION_ID_ENV, 'session-1')
    const refusal = BOT_REPLY_HANDLERS['bot reply']({
      flags: new Map([['text', 'hi']]),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler uses only client.call, supplied here.
      client: refusingClient(code) as never,
      cwd: '/',
      json: true
    })
    await expect(refusal).rejects.toMatchObject({ code })
    await expect(refusal).rejects.toThrow(says)
  })

  it('says replies are unavailable when the host cannot post for anyone', async () => {
    vi.stubEnv('ORCA_PANE_KEY', 'tab-1:pane-1')
    await expect(
      BOT_REPLY_HANDLERS['bot reply']({
        flags: new Map([['text', 'hi']]),
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler uses only client.call, supplied here.
        client: refusingClient('connector_not_connected') as never,
        cwd: '/',
        json: true
      })
    ).rejects.toMatchObject({
      code: 'not_a_cloud_conversation',
      message: CONNECTOR_REPLY_UNAVAILABLE
    })
  })

  it('reacts on the waking message, then posts the text', async () => {
    vi.stubEnv('ORCA_PANE_KEY', '')
    vi.stubEnv(ORCA_SCRUB_SAFE_PANE_ENV, '')
    vi.stubEnv(ORCA_AGENT_SESSION_ID_ENV, 'session-1')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const call = vi.fn(async (method: string) => ({
      id: '1',
      ok: true,
      result: method === 'connector.react' ? { ok: true } : { status: 'posted' },
      _meta: { runtimeId: 'r' }
    }))

    await BOT_REPLY_HANDLERS['bot reply']({
      flags: new Map([
        ['react', ':eyes:'],
        ['text', 'On it.']
      ]),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler uses only client.call, supplied here.
      client: { call } as never,
      cwd: '/',
      json: false
    })

    expect(call.mock.calls.map(([method]) => method)).toEqual([
      'connector.react',
      'connector.reply'
    ])
    expect(call).toHaveBeenCalledWith(
      'connector.react',
      { sessionId: 'session-1', emoji: ':eyes:' },
      expect.anything()
    )
    expect(log).toHaveBeenCalledWith('Reacted :eyes:.\nPosted to the thread.')
  })

  it('needs --text or --react, and --text with line notes', async () => {
    vi.stubEnv(ORCA_AGENT_SESSION_ID_ENV, 'session-1')
    const run = (flags: Map<string, string>) =>
      BOT_REPLY_HANDLERS['bot reply']({
        flags,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: refused before any call.
        client: refusingClient('unused') as never,
        cwd: '/',
        json: true
      })
    await expect(run(new Map())).rejects.toThrow('Give --text, --file or --react.')
    await expect(
      run(
        new Map([
          ['note', 'a.ts:1:x'],
          ['react', ':eyes:']
        ])
      )
    ).rejects.toThrow('Line notes need --text')
    await expect(run(new Map([['note', 'a.ts:1:x']]))).rejects.toThrow('Line notes need --text')
  })

  it('attaches a file as the reply: a slot in the waking thread, the bytes straight to it, then the post with --text', async () => {
    vi.stubEnv('ORCA_PANE_KEY', '')
    vi.stubEnv(ORCA_SCRUB_SAFE_PANE_ENV, '')
    vi.stubEnv(ORCA_AGENT_SESSION_ID_ENV, 'session-1')
    const dir = mkdtempSync(join(tmpdir(), 'orca-bot-reply-'))
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 1, 7)
    writeFileSync(join(dir, 'build.bin'), bytes)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const sent: Buffer[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(Buffer.from(await new Response(init.body).arrayBuffer()))
        return new Response('OK')
      })
    )
    const call = vi.fn(async (_method: unknown, params: unknown) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connector.act params, as the handler sends them.
      (params as { args: { stage?: true } }).args.stage
        ? answered({ staged: true, upload: { url: 'https://files.slack.com/upload/v1/x' } })
        : answered({ target: { ref: 'slack:T1:C1:1.2', label: '#eng' } })
    )
    try {
      await BOT_REPLY_HANDLERS['bot reply']({
        flags: new Map([
          ['file', 'build.bin'],
          ['text', 'the log']
        ]),
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler uses only client.call, supplied here.
        client: { call } as never,
        cwd: dir,
        json: false
      })
    } finally {
      vi.unstubAllGlobals()
      rmSync(dir, { recursive: true, force: true })
    }
    const args = call.mock.calls.map(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connector.act params, as the handler sends them.
      (entry) => entry[1] as { verb: string; args: Record<string, unknown> }
    )
    expect(args.map((entry) => entry.verb)).toEqual(['reply', 'reply'])
    expect(args[0]?.args).toEqual({
      upload: { name: 'build.bin', size: bytes.length },
      stage: true,
      postId: expect.any(String)
    })
    // The comment rides with the file rather than posting on its own.
    expect(args[1]?.args).toEqual({
      files: [args[0]?.args.postId],
      text: 'the log',
      postId: expect.any(String)
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.equals(bytes)).toBe(true)
    expect(log).toHaveBeenCalledWith('The file posted to #eng.')
  })

  async function replyWithTwoFiles(call: (...args: unknown[]) => Promise<unknown>) {
    vi.stubEnv('ORCA_PANE_KEY', '')
    vi.stubEnv(ORCA_SCRUB_SAFE_PANE_ENV, '')
    vi.stubEnv(ORCA_AGENT_SESSION_ID_ENV, 'session-1')
    const dir = mkdtempSync(join(tmpdir(), 'orca-bot-reply-'))
    writeFileSync(join(dir, 'a.png'), 'A')
    writeFileSync(join(dir, 'b.png'), 'B')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('OK'))
    )
    try {
      await BOT_REPLY_HANDLERS['bot reply']({
        flags: new Map([
          ['file', ['a.png', 'b.png'].join(REPEATED_FLAG_SEPARATOR)],
          ['text', 'before and after']
        ]),
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler uses only client.call, supplied here.
        client: { call } as never,
        cwd: dir,
        json: false
      })
    } finally {
      vi.unstubAllGlobals()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const answered = (result: unknown) => ({
    id: '1',
    ok: true,
    result: { ok: true, result },
    _meta: { runtimeId: 'r' }
  })

  it('stages each file, then posts them with the text as one reply', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const call = vi.fn(async (_method: unknown, params: unknown) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connector.act params, as the handler sends them.
      (params as { args: { stage?: true } }).args.stage
        ? answered({ staged: true, upload: { url: 'https://files.slack.com/upload/v1/x' } })
        : answered({
            target: { ref: 'slack:T1:C1:1.2', label: '#eng' },
            place: 'the Slack thread in #eng'
          })
    )
    await replyWithTwoFiles(call)
    const args = call.mock.calls.map(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connector.act params, as the handler sends them.
      (entry) => (entry[1] as { args: Record<string, unknown> }).args
    )
    expect(args).toEqual([
      { upload: { name: 'a.png', size: 1 }, stage: true, postId: expect.any(String) },
      { upload: { name: 'b.png', size: 1 }, stage: true, postId: expect.any(String) },
      {
        files: [args[0]?.postId, args[1]?.postId],
        text: 'before and after',
        postId: expect.any(String)
      }
    ])
    expect(log).toHaveBeenCalledWith('2 files posted to the Slack thread in #eng.')
  })

  it('tells the posting turn why its file reply can’t wake an Orca bot it mentions', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const notice = "Scout won't take this as a request."
    const call = vi.fn(async (_method: unknown, params: unknown) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connector.act params, as the handler sends them.
      (params as { args: { stage?: true } }).args.stage
        ? answered({ staged: true, upload: { url: 'https://files.slack.com/upload/v1/x' } })
        : answered({
            target: { ref: 'slack:T1:C1:1.2', label: '#eng' },
            place: 'the Slack thread in #eng',
            notices: [notice]
          })
    )
    await replyWithTwoFiles(call)
    expect(log).toHaveBeenCalledWith(`2 files posted to the Slack thread in #eng.\n${notice}`)
  })

  it('waits for a queued reply of files to post, and says when Slack refused part of it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 500 })
    let finalAsks = 0
    const call = vi.fn(async (_method: unknown, params: unknown) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connector.act params, as the handler sends them.
      const args = (params as { args: { stage?: true } }).args
      if (args.stage) {
        return answered({ staged: true, upload: { url: 'https://files.slack.com/upload/v1/x' } })
      }
      finalAsks += 1
      return finalAsks === 1
        ? answered({ target: { ref: 'slack:T1:C1', label: '#eng (queued)' }, queued: true })
        : {
            id: '1',
            ok: true,
            result: {
              ok: false,
              refusal: 'post_failed',
              message: "Part of that reply wasn't posted"
            },
            _meta: { runtimeId: 'r' }
          }
    })
    try {
      await expect(replyWithTwoFiles(call)).rejects.toMatchObject({ code: 'post_failed' })
    } finally {
      vi.useRealTimers()
    }
    expect(finalAsks).toBe(2)
  })

  it('keeps a queued reply of files when asking how it went fails', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 500 })
    let finalAsks = 0
    const call = vi.fn(async (_method: unknown, params: unknown) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connector.act params, as the handler sends them.
      if ((params as { args: { stage?: true } }).args.stage) {
        return answered({ staged: true, upload: { url: 'https://files.slack.com/upload/v1/x' } })
      }
      finalAsks += 1
      if (finalAsks > 1) {
        throw new RuntimeClientError('runtime_timeout', 'no answer')
      }
      return answered({ target: { ref: 'slack:T1:C1', label: '#eng' }, queued: true })
    })
    try {
      await replyWithTwoFiles(call)
    } finally {
      vi.useRealTimers()
    }
    expect(log).toHaveBeenCalledWith(
      "2 files went to Orca Cloud, which posts them to #eng shortly. Orca couldn't confirm they posted; read the thread before sending them again."
    )
  })

  it('posts nothing when Orca Cloud takes no direct files, or Slack refuses a file', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const lacking = vi.fn(async () => {
      throw new RuntimeClientError('cloud_lacks_direct_files', "Orca Cloud can't take files")
    })
    await expect(replyWithTwoFiles(lacking)).rejects.toMatchObject({
      code: 'cloud_lacks_direct_files'
    })
    expect(lacking).toHaveBeenCalledTimes(1)
    const call = vi.fn(async () =>
      answered({ staged: true, upload: { url: 'https://files.slack.com/upload/v1/x' } })
    )
    // Slack refuses the bytes: fetch is swapped in after the stand-in host's OK one.
    const refusing = async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 500 }))
      )
      return await call()
    }
    await expect(replyWithTwoFiles(refusing)).rejects.toMatchObject({ code: 'upload_failed' })
    // Only the first slot was taken; nothing named it in a reply.
    expect(call).toHaveBeenCalledTimes(1)
  })
})
