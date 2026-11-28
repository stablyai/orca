import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secure-storage/secret-store'
import { CodexAppServerRequestError } from '../codex/app-server/codex-app-server-request-error'
import {
  commitBotToolOAuth,
  newBotToolCredentialId,
  useBotToolCredentialsRoot
} from './bot-tool-credentials'
import { addBotTool, botToolProblems, type BotToolsCli } from './bot-tools-host'
import { connectBotTool } from './bot-tools-sign-in'
import { botToolRelay } from './tool-relay/bot-tool-relay'
import type * as SessionModule from '../codex/app-server/codex-app-server-session'

type Answer = (method: string, params: Record<string, unknown>) => unknown

/** A thread/start's config, as Orca sends it: dotted keys. */
function configOf(params: Record<string, unknown>): Record<string, unknown> {
  const { config } = params
  return typeof config === 'object' && config !== null
    ? Object.fromEntries(Object.entries(config))
    : {}
}

const session = vi.hoisted(() => {
  const state: {
    /** Codex's loaded servers; null: its config can't be read. */
    loaded: Record<string, unknown> | null
    invocations: { args: string[] }[]
    methods: string[]
    /** The config of each thread/start, in order. */
    starts: Record<string, unknown>[]
    /** A test's own answer to a request; undefined falls back to the defaults. */
    answer: Answer | null
    /** Ends the session as its deadline does, whatever its body is waiting on. */
    deadline: Promise<never> | null
  } = {
    loaded: {},
    invocations: [],
    methods: [],
    starts: [],
    answer: null,
    deadline: null
  }
  return state
})

vi.mock('../codex/app-server/codex-app-server-session', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionModule>()),
  // A Codex app-server whose loaded config (every layer, `config/read`) has `session.loaded`.
  runCodexAppServerSession: vi.fn(
    async (
      invocation: { args: string[]; signal?: AbortSignal },
      body: (rpc: unknown) => Promise<unknown>
    ) => {
      session.invocations.push(invocation)
      const ran = body({
        notify: vi.fn(),
        request: async (method: string, params: Record<string, unknown> = {}) => {
          session.methods.push(method)
          if (method === 'thread/start') {
            session.starts.push(configOf(params))
          }
          const own = await session.answer?.(method, params)
          if (own !== undefined) {
            return own
          }
          if (method === 'config/read') {
            if (!session.loaded) {
              throw new Error('config/read failed')
            }
            return { config: { mcp_servers: session.loaded } }
          }
          if (method === 'thread/start') {
            return { thread: { id: 'thread-1' } }
          }
          if (method === 'mcpServerStatus/list') {
            return {
              data: ['linear', 'notion', 'docs'].map((name) => ({
                name,
                runtimeStatus: 'connected'
              }))
            }
          }
          if (method === 'mcpServer/oauth/login') {
            return { authorizationUrl: 'https://sign.in/page' }
          }
          return {}
        }
      })
      const ends = [ran, ...(session.deadline ? [session.deadline] : [])]
      const { signal } = invocation
      if (signal) {
        ends.push(
          new Promise<never>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          )
        )
      }
      return await Promise.race(ends)
    }
  )
}))

/** What Codex 0.171 answers a thread whose server has both a command and a URL. */
const refusal = (name: string) => {
  const text = `failed to load configuration: url is not supported for stdio\nin \`mcp_servers.${name}\``
  return new CodexAppServerRequestError(
    'thread/start',
    -32600,
    `codex app-server thread/start failed: ${text}`,
    text
  )
}

const dirs: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

beforeEach(() => {
  session.loaded = {}
  session.invocations.length = 0
  session.methods.length = 0
  session.starts.length = 0
  session.answer = null
  session.deadline = null
  useBotToolCredentialsRoot(tempDir('bot-tool-credentials-'))
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(text, 'utf8'),
    decryptString: (cipher) => cipher.toString('utf8'),
    describeProtectionGap: () => null
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  useBotToolCredentialsRoot(null)
  _resetSecretStoreForTests()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function codexBot(): BotToolsCli {
  const folder = tempDir('bot-folder-')
  return {
    botId: 'bot',
    folder,
    signInFolder: folder,
    otherBotFolders: [],
    agent: 'codex',
    command: 'codex',
    prefixArgs: [],
    env: {},
    // An account whose config.toml has no notion; Codex's loaded config does.
    accountHome: tempDir('codex-home-'),
    chatArgs: { args: ['-c', 'mcp_servers.notion.command="npx"'] }
  }
}

const NOTION = 'https://mcp.notion.com/mcp'
const LINEAR = 'https://mcp.linear.app/mcp'
const taken = (name: string) => ({
  kind: 'failed',
  reason: 'nameTaken',
  detail: expect.stringContaining(`Codex already has a tool named ${name}`)
})
const notFinished = { kind: 'unconfirmed', detail: expect.stringContaining('could not check') }

/** A notion tool Orca signed in to, so a check reads its state from Orca's store. */
async function addSignedInNotion(cli: BotToolsCli): Promise<void> {
  const id = newBotToolCredentialId()
  await addBotTool(
    cli,
    { name: 'notion', url: NOTION, transport: 'http', credential: id },
    new Map([[id, { url: NOTION, signIn: true as const }]])
  )
  commitBotToolOAuth(cli.folder, id, (current) => ({
    url: NOTION,
    grant: current!.grant + 1,
    record: { resource: NOTION, tokens: { access_token: 'access', token_type: 'bearer' } }
  }))
}

describe('a Codex bot’s tools check', () => {
  it('fails a signed-in tool whose name Codex’s config runs as a command, without connecting it', async () => {
    const cli = codexBot()
    await addSignedInNotion(cli)
    session.loaded = { notion: { command: 'npx' } }
    const grant = vi.spyOn(botToolRelay, 'grant')

    expect(await botToolProblems(cli)).toEqual({ notion: taken('notion') })
    // Read the config only: no thread, so no server was started, and no relay grant was made.
    expect(session.methods).toEqual(['config/read'])
    expect(grant).not.toHaveBeenCalled()
    // Checked with the Codex Arguments a chat launches with.
    expect(session.invocations[0].args).toEqual([
      '-c',
      'mcp_servers.notion.command="npx"',
      'app-server'
    ])
  })

  it('checks only saved sign-ins with one config read, no grant, thread or status call', async () => {
    const cli = codexBot()
    await addSignedInNotion(cli)
    const grant = vi.spyOn(botToolRelay, 'grant')

    expect(await botToolProblems(cli)).toEqual({})
    expect(session.methods).toEqual(['config/read'])
    expect(grant).not.toHaveBeenCalled()
  })

  it('says a saved sign-in is unconfirmed, not working, when the config can’t be read', async () => {
    const cli = codexBot()
    await addSignedInNotion(cli)
    session.loaded = null

    expect(await botToolProblems(cli)).toEqual({ notion: notFinished })
    expect(session.methods).toEqual(['config/read'])
  })

  it('checks the other tools in a thread without the left-out one', async () => {
    const cli = codexBot()
    await addBotTool(cli, { name: 'notion', url: NOTION, transport: 'http' })
    await addBotTool(cli, { name: 'linear', url: 'https://mcp.linear.app/mcp', transport: 'http' })
    session.loaded = { notion: { command: 'npx' } }

    expect(await botToolProblems(cli)).toEqual({ notion: taken('notion') })
    expect(session.methods).toEqual(['config/read', 'thread/start', 'mcpServerStatus/list'])
  })

  it('keeps a known conflict when the status call fails, and says the others weren’t checked', async () => {
    const cli = codexBot()
    await addSignedInNotion(cli)
    await addBotTool(cli, { name: 'linear', url: LINEAR, transport: 'http' })
    session.loaded = { notion: { command: 'npx' } }
    session.answer = (method) => {
      if (method === 'mcpServerStatus/list') {
        throw new Error('status failed')
      }
      return undefined
    }

    expect(await botToolProblems(cli)).toEqual({ notion: taken('notion'), linear: notFinished })
  })

  it('keeps a conflict learned at the open when the next open fails', async () => {
    const cli = codexBot()
    await addBotTool(cli, { name: 'notion', url: NOTION, transport: 'http' })
    await addBotTool(cli, { name: 'linear', url: LINEAR, transport: 'http' })
    session.answer = (method, params) => {
      if (method !== 'thread/start') {
        return undefined
      }
      if (configOf(params)['mcp_servers.notion.url']) {
        throw refusal('notion')
      }
      throw new Error('spawn failed')
    }

    expect(await botToolProblems(cli)).toEqual({ notion: taken('notion'), linear: notFinished })
    expect(session.methods.filter((method) => method === 'thread/start')).toHaveLength(2)
  })

  it('keeps a known conflict when the session’s deadline ends it', async () => {
    const cli = codexBot()
    await addBotTool(cli, { name: 'notion', url: NOTION, transport: 'http' })
    await addBotTool(cli, { name: 'linear', url: LINEAR, transport: 'http' })
    session.loaded = { notion: { command: 'npx' } }
    const deadline = Promise.withResolvers<never>()
    session.deadline = deadline.promise
    session.answer = (method) =>
      method === 'mcpServerStatus/list'
        ? (deadline.reject(new Error('codex app-server timed out')), new Promise(() => {}))
        : undefined

    expect(await botToolProblems(cli)).toEqual({ notion: taken('notion'), linear: notFinished })
  })

  it('throws away what it knows when cancelled', async () => {
    const cli = codexBot()
    await addBotTool(cli, { name: 'notion', url: NOTION, transport: 'http' })
    await addBotTool(cli, { name: 'linear', url: LINEAR, transport: 'http' })
    session.loaded = { notion: { command: 'npx' } }
    const cancel = new AbortController()
    session.answer = (method) =>
      method === 'mcpServerStatus/list' ? (cancel.abort(), new Promise(() => {})) : undefined

    await expect(botToolProblems(cli, { signal: cancel.signal })).rejects.toThrow()
  })

  it('asks no status when the open leaves out the last tool', async () => {
    const cli = codexBot()
    await addBotTool(cli, { name: 'notion', url: NOTION, transport: 'http' })
    session.answer = (method, params) =>
      method === 'thread/start' && configOf(params)['mcp_servers.notion.url']
        ? Promise.reject(refusal('notion'))
        : undefined

    expect(await botToolProblems(cli)).toEqual({ notion: taken('notion') })
    expect(session.methods).toEqual(['config/read', 'thread/start'])
  })

  it('starts only the bot’s servers: every other one Codex loads is off', async () => {
    const cli = codexBot()
    await addBotTool(cli, { name: 'linear', url: LINEAR, transport: 'http' })
    session.loaded = { github: { command: 'gh-mcp' }, linear: { url: 'https://owner/mcp' } }

    expect(await botToolProblems(cli, { remote: true })).toEqual({})
    expect(session.starts).toEqual([
      expect.objectContaining({
        'mcp_servers.linear.url': LINEAR,
        'mcp_servers.github.enabled': false
      })
    ])
    expect(session.starts[0]).not.toHaveProperty(['mcp_servers.linear.enabled'])
  })

  it('turns off the owner’s server under a name it leaves out, in a remote check', async () => {
    const cli = codexBot()
    await addBotTool(cli, { name: 'notion', url: NOTION, transport: 'http' })
    await addBotTool(cli, { name: 'linear', url: LINEAR, transport: 'http' })
    session.loaded = { notion: { command: 'npx' }, linear: { url: 'https://owner/mcp' } }

    expect(await botToolProblems(cli, { remote: true })).toEqual({ notion: taken('notion') })
    expect(session.starts).toEqual([
      { 'mcp_servers.linear.url': LINEAR, 'mcp_servers.notion.enabled': false }
    ])
  })

  it('opens again with the refused name and every other loaded server off', async () => {
    const cli = codexBot()
    await addBotTool(cli, { name: 'notion', url: NOTION, transport: 'http' })
    await addBotTool(cli, { name: 'linear', url: LINEAR, transport: 'http' })
    session.loaded = { github: { command: 'gh-mcp' } }
    session.answer = (method, params) =>
      method === 'thread/start' && configOf(params)['mcp_servers.notion.url']
        ? Promise.reject(refusal('notion'))
        : undefined

    expect(await botToolProblems(cli)).toEqual({ notion: taken('notion') })
    expect(session.starts).toEqual([
      expect.objectContaining({
        'mcp_servers.notion.url': NOTION,
        'mcp_servers.github.enabled': false
      }),
      {
        'mcp_servers.linear.url': LINEAR,
        'mcp_servers.github.enabled': false,
        'mcp_servers.notion.enabled': false
      }
    ])
  })

  it('opens no more in a remote check once Codex shows a layer its read missed', async () => {
    const cli = codexBot()
    await addBotTool(cli, { name: 'notion', url: NOTION, transport: 'http' })
    await addBotTool(cli, { name: 'linear', url: LINEAR, transport: 'http' })
    session.answer = (method) =>
      method === 'thread/start' ? Promise.reject(refusal('notion')) : undefined

    expect(await botToolProblems(cli, { remote: true })).toEqual({
      notion: taken('notion'),
      linear: notFinished
    })
    expect(session.methods).toEqual(['config/read', 'thread/start'])
  })

  it('keeps a conflict in the account’s config.toml when the whole check fails', async () => {
    const cli = codexBot()
    await addBotTool(cli, { name: 'notion', url: NOTION, transport: 'http' })
    await addBotTool(cli, { name: 'linear', url: LINEAR, transport: 'http' })
    writeFileSync(
      join(cli.accountHome ?? '', 'config.toml'),
      '[mcp_servers.notion]\ncommand = "npx"\n'
    )
    session.deadline = Promise.reject(new Error('codex app-server could not start'))
    session.deadline.catch(() => {})

    expect(await botToolProblems(cli)).toEqual({ notion: taken('notion'), linear: notFinished })
  })

  it('keeps a tool’s last definite status when a later ask fails, and a newer one replaces it', async () => {
    const cli = codexBot()
    await addBotTool(cli, { name: 'linear', url: LINEAR, transport: 'http' })
    await addBotTool(cli, { name: 'docs', url: 'https://docs.example/mcp', transport: 'http' })
    const asks = (answers: unknown[]) => {
      let asked = 0
      session.answer = (method) => {
        if (method !== 'mcpServerStatus/list') {
          return undefined
        }
        const answer = answers[asked++]
        return answer instanceof Error ? Promise.reject(answer) : answer
      }
    }
    // linear answers working; docs hasn't, and then the ask fails.
    asks([{ data: [{ name: 'linear', runtimeStatus: 'connected' }] }, new Error('ask failed')])
    expect(await botToolProblems(cli)).toEqual({ docs: notFinished })

    session.methods.length = 0
    // linear answers failed, then a newer answer says it is working.
    asks([
      { data: [{ name: 'linear', runtimeStatus: 'failed' }] },
      {
        data: [
          { name: 'linear', runtimeStatus: 'connected' },
          { name: 'docs', runtimeStatus: 'connected' }
        ]
      }
    ])
    expect(await botToolProblems(cli)).toEqual({})
  })

  it('makes no grant, open or status call when Codex’s config refuses every tool to start', async () => {
    const cli = codexBot()
    await addSignedInNotion(cli)
    await addBotTool(cli, { name: 'linear', url: LINEAR, transport: 'http' })
    session.loaded = { linear: { command: 'npx' } }
    const grant = vi.spyOn(botToolRelay, 'grant')

    expect(await botToolProblems(cli)).toEqual({ linear: taken('linear') })
    expect(session.methods).toEqual(['config/read'])

    session.methods.length = 0
    session.loaded = null
    expect(await botToolProblems(cli, { remote: true })).toEqual({
      notion: notFinished,
      linear: notFinished
    })
    expect(session.methods).toEqual(['config/read'])
    expect(grant).not.toHaveBeenCalled()
  })

  it('fails every tool, starting nothing, for Arguments a chat can’t launch with', async () => {
    const cli = { ...codexBot(), chatArgs: { invalid: 'codex Arguments are invalid: bad quote' } }
    await addBotTool(cli, { name: 'linear', url: LINEAR, transport: 'http' })
    await addBotTool(cli, { name: 'docs', command: 'docs-mcp', args: [] })

    const failed = { kind: 'failed', detail: 'codex Arguments are invalid: bad quote' }
    expect(await botToolProblems(cli)).toEqual({ linear: failed, docs: failed })
    expect(session.invocations).toEqual([])
    await expect(connectBotTool(cli.botId, 'linear', async () => cli)).rejects.toMatchObject({
      name: 'BotFailureError'
    })
    expect(session.invocations).toEqual([])
  })

  it('launches with no root options for empty Arguments', async () => {
    const cli = { ...codexBot(), chatArgs: { args: [] } }
    await addBotTool(cli, { name: 'linear', url: LINEAR, transport: 'http' })

    expect(await botToolProblems(cli)).toEqual({})
    expect(session.invocations[0].args).toEqual(['app-server'])
  })

  it('opens nothing for a remote check when the config can’t be read', async () => {
    const cli = codexBot()
    await addBotTool(cli, { name: 'linear', url: LINEAR, transport: 'http' })
    await addBotTool(cli, { name: 'docs', command: 'docs-mcp', args: [] })
    session.loaded = null

    expect(await botToolProblems(cli, { remote: true })).toEqual({ linear: notFinished })
    expect(session.methods).toEqual(['config/read'])
  })
})

describe('a Codex bot tool’s sign-in', () => {
  const takenError = {
    name: 'BotFailureError',
    data: { botFailure: expect.objectContaining({ code: 'toolNameTakenByCodexStdio' }) }
  }

  it('says the name is taken before opening a thread when Codex’s config has it as a command', async () => {
    const cli = codexBot()
    await addBotTool(cli, { name: 'notion', url: NOTION, transport: 'http' })
    session.loaded = { notion: { command: 'npx' } }

    await expect(connectBotTool(cli.botId, 'notion', async () => cli)).rejects.toMatchObject(
      takenError
    )
    expect(session.methods).toEqual(['config/read'])
  })

  it('says the name is taken after the one open Codex refuses it at, without opening again', async () => {
    const cli = codexBot()
    await addBotTool(cli, { name: 'notion', url: NOTION, transport: 'http' })
    session.answer = (method) =>
      method === 'thread/start' ? Promise.reject(refusal('notion')) : undefined

    await expect(connectBotTool(cli.botId, 'notion', async () => cli)).rejects.toMatchObject(
      takenError
    )
    expect(session.methods).toEqual(['config/read', 'thread/start'])
  })

  it('signs in when only another tool’s name is taken', async () => {
    const cli = codexBot()
    await addBotTool(cli, { name: 'notion', url: NOTION, transport: 'http' })
    await addBotTool(cli, { name: 'linear', url: LINEAR, transport: 'http' })
    session.loaded = { linear: { command: 'npx' } }

    expect(await connectBotTool(cli.botId, 'notion', async () => cli)).toEqual({
      authorizationUrl: 'https://sign.in/page'
    })
    expect(session.starts).toEqual([
      expect.not.objectContaining({ 'mcp_servers.linear.url': LINEAR })
    ])
    expect(session.methods).toContain('mcpServer/oauth/login')
  })
})
