import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch/dispatch'
import type { RuntimeClient } from '../runtime/client'
import type { GoogleStatusView } from '../../shared/google/google-connect-types'
import { formatGoogleStatus, GOOGLE_HANDLERS, readServices, runGoogleConnect } from './google'
import type { AuthInterruptSource } from '../accounts/auth-interrupts'

const PROMPT = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=s1',
  redirectUri: 'http://127.0.0.1:5555/google/callback',
  expiresAt: 1,
  browserOpened: false
}
const ACCOUNT = {
  email: 'ada@acme.dev',
  status: 'connected' as const,
  services: [{ service: 'gmail' as const, state: 'ready' as const }],
  connectedAt: 1
}

type Handler = (params: Record<string, unknown> | undefined) => unknown

function fakeHost(overrides: Record<string, Handler> = {}) {
  const handlers: Record<string, Handler> = {
    'status.get': () => ({ capabilities: ['google.connect.v1'] }),
    'google.signIn.start': () => ({ flowId: 'f1', revision: 1, phase: 'starting' }),
    'google.signIn.cancel': () => ({}),
    ...overrides
  }
  const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    const handler = handlers[method]
    if (!handler) {
      throw new Error(`unexpected ${method}`)
    }
    return { id: 'req', ok: true, result: await handler(params), _meta: { runtimeId: 'rt' } }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers under test only use `call`.
  const client = { call } as unknown as RuntimeClient
  return { call, client }
}

const context = (
  client: RuntimeClient,
  flags: [string, string | boolean][] = []
): HandlerContext => ({
  client,
  cwd: process.cwd(),
  flags: new Map(flags),
  json: false,
  rawArgs: []
})

const noInterrupts: AuthInterruptSource = () => () => {}

describe('orca google', () => {
  let stderr: string
  let stdout: string[]
  const savedSession = process.env.ORCA_AGENT_SESSION_ID

  beforeEach(() => {
    delete process.env.ORCA_AGENT_SESSION_ID
    stderr = ''
    stdout = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      stdout.push(String(line))
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    if (savedSession === undefined) {
      delete process.env.ORCA_AGENT_SESSION_ID
    } else {
      process.env.ORCA_AGENT_SESSION_ID = savedSession
    }
  })

  it('prints the link on a host with no browser, relays pasted addresses until one is taken', async () => {
    let finish: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const { client, call } = fakeHost({
      'google.signIn.wait': async (params) => {
        if (params?.afterRevision === 1) {
          return { flowId: 'f1', revision: 2, phase: 'waiting', prompt: PROMPT }
        }
        await finished
        return { flowId: 'f1', revision: 4, phase: 'signedIn', account: ACCOUNT }
      },
      'google.finishSignIn': (params) => {
        if (params?.address !== `${PROMPT.redirectUri}?state=s1&code=c`) {
          throw new Error("That address isn't from the Google sign-in Orca just started")
        }
        finish()
        return { flowId: 'f1', revision: 3, phase: 'verifying' }
      }
    })
    const input = new PassThrough()
    const run = runGoogleConnect(context(client), noInterrupts, input)
    await vi.waitFor(() => expect(stderr).toContain(PROMPT.authorizeUrl))
    expect(stderr).toContain('paste it here')
    input.write('http://127.0.0.1:5555/google/callback?state=wrong&code=c\n')
    await vi.waitFor(() => expect(stderr).toContain("isn't from the Google sign-in"))
    input.write(`${PROMPT.redirectUri}?state=s1&code=c\n`)
    await run
    expect(stdout.join('\n')).toContain('Connected Google as ada@acme.dev.')
    expect(call.mock.calls.filter(([method]) => method === 'google.finishSignIn')).toHaveLength(2)
    expect(call.mock.calls.some(([method]) => method === 'google.signIn.cancel')).toBe(false)
  })

  it('says Google connected when Ctrl+C comes after the host finished', async () => {
    const fire = { now: (): void => {} }
    const interrupts: AuthInterruptSource = (onInterrupt) => {
      fire.now = () => onInterrupt('SIGINT')
      return () => {
        fire.now = () => {}
      }
    }
    const { client } = fakeHost({
      'google.signIn.wait': async (params) =>
        params?.afterRevision === 1
          ? { flowId: 'f1', revision: 2, phase: 'waiting', prompt: PROMPT }
          : new Promise(() => {}),
      'google.signIn.cancel': () => ({ flowId: 'f1', revision: 5, phase: 'signedIn' })
    })
    const run = runGoogleConnect(context(client), interrupts, new PassThrough())
    await vi.waitFor(() => expect(stderr).toContain(PROMPT.authorizeUrl))
    fire.now()
    await expect(run).rejects.toThrow('Google had already connected')
  })

  it('cancels the sign-in on the host when it fails to start', async () => {
    const { client, call } = fakeHost({
      'google.signIn.wait': () => ({
        flowId: 'f1',
        revision: 2,
        phase: 'failed',
        error: 'Add your team’s Google client first'
      })
    })
    await expect(
      runGoogleConnect(context(client), noInterrupts, new PassThrough())
    ).rejects.toThrow('Google client first')
    expect(call.mock.calls.some(([method]) => method === 'google.signIn.cancel')).toBe(false)
  })

  it('sends the calling chat with owner-only changes, so the host can refuse a bot', async () => {
    process.env.ORCA_AGENT_SESSION_ID = 'bot-chat'
    const { client, call } = fakeHost({
      'google.disconnect': () => ({ removed: 'ada@acme.dev', revoked: null })
    })
    await GOOGLE_HANDLERS['google disconnect']?.(context(client))
    const sent = call.mock.calls.find(([method]) => method === 'google.disconnect')?.[1]
    expect(sent).toMatchObject({ callerSessionId: 'bot-chat' })
    expect(stdout.join('\n')).toContain('add --revoke')
  })

  it('needs exactly one of --on and --off for a bot', async () => {
    const { client } = fakeHost()
    await expect(
      GOOGLE_HANDLERS['google bot']?.(context(client, [['bot', 'Scout']]))
    ).rejects.toThrow('--on or --off')
  })

  it('reads --services as Gmail, Calendar and Files, and refuses anything else', () => {
    expect(readServices(undefined)).toBeUndefined()
    expect(readServices('files, Gmail,gmail')).toEqual(['gmail', 'files'])
    expect(() => readServices('gmail,drive')).toThrow('not drive')
    expect(() => readServices(',')).toThrow('--services takes')
  })

  it('shows services, reconnects and the bots that may use Google', () => {
    const view: GoogleStatusView = {
      client: {
        clientId: 'c.apps.googleusercontent.com',
        projectId: 'acme',
        source: 'imported',
        savedAt: 1
      },
      accounts: [
        {
          ...ACCOUNT,
          services: [
            { service: 'gmail', state: 'ready' },
            {
              service: 'calendar',
              state: 'api-disabled',
              enableUrl:
                'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com'
            }
          ]
        },
        {
          email: 'me@gmail.com',
          status: 'reconnect',
          reason: 'Google access ended.',
          services: [],
          connectedAt: 2
        }
      ],
      bots: [{ id: 'b1', name: 'Scout' }]
    }
    const text = formatGoogleStatus(view)
    expect(text).toContain('Gmail: ready')
    expect(text).toContain(
      'Calendar: API off in your Google project (https://console.cloud.google.com/'
    )
    expect(text).toContain('me@gmail.com: Reconnect.')
    expect(text).toContain('Bots that may use Google: Scout')
  })
})
