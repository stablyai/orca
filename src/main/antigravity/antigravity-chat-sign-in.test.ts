// The chat sign-in against a scripted Antigravity server.

import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import type { terminateProviderProcessTree } from '../provider-process/provider-process-teardown'
import { createAcpAgentConnection, type AcpAgentConnection } from '../acp/acp-agent-connection'
import { ANTIGRAVITY_LAUNCH_SPEC } from '../acp/acp-launch-specs'
import { prepareAcpStructuredLaunch } from '../acp/acp-structured-launch-preparation'
import type { ConnectAcpAgent } from '../acp/acp-structured-connection'
import { AcpScriptedAgent, deferred } from '../acp/acp-scripted-agent.test-support'
import type { RpcContext } from '../runtime/rpc/core'
import type { RpcCallerIdentity } from '../runtime/rpc/rpc-caller-identity'
import { ANTIGRAVITY_ACCOUNT_METHODS } from '../runtime/rpc/methods/antigravity-accounts'
import type { AntigravityChatSignInStatus } from '../../shared/antigravity-account-types'
import { ANTIGRAVITY_BROWSER_MARKER } from './antigravity-browser-helper'
import * as browserHelper from './antigravity-browser-helper'
import { ANTIGRAVITY_SIGN_IN_PROMPT, antigravitySignInUrl } from './antigravity-sign-in-url'
import {
  cancelAntigravityChatSignIn,
  completeAntigravityChatSignIn,
  readAntigravityChatSignInStatus,
  startAntigravityChatSignIn
} from './antigravity-chat-sign-in'

vi.mock('../provider-process/provider-process-teardown', () => ({
  terminateProviderProcessTree: vi.fn<typeof terminateProviderProcessTree>(
    async () => 'unverifiable'
  )
}))

const GOOGLE_LINK =
  'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=s1&redirect_uri=http%3A%2F%2F127.0.0.1%3A41234%2F'
// Any host, even one without a published server build, signs in against the fake.
const PIN = {
  version: '1.3.0',
  url: 'https://example.test/agy.zip',
  archiveSha256: 'a'.repeat(64),
  archiveBytes: 1,
  members: []
}
const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001'
const DESKTOP = 'trusted-local:desktop'
const PHONE: RpcCallerIdentity = { kind: 'paired-device', deviceId: 'phone' }
const folders: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

/** A scripted server process whose stdin closing is its exit. */
function fakeServer(agent: AcpScriptedAgent, stderr = new PassThrough()) {
  agent.on('initialize', (frame) => agent.reply(frame, { protocolVersion: 1 }))
  const child = Object.assign(createFakePipedChild(), {
    pid: 9_999_998,
    stdout: agent.stdout,
    stdin: agent.stdin,
    stderr,
    kill: vi.fn(() => true)
  })
  child.stdin.once('finish', () => child.emit('exit', 0, null))
  return child
}

/** Scripted browser output; the real command/parser has its own fixture. */
async function helperOutput(link: string): Promise<string> {
  return `${ANTIGRAVITY_BROWSER_MARKER}${JSON.stringify(link)}\n`
}

const sessionFile = (folder: string, suffix: string) =>
  join(folder, 'antigravity-acp', 'conversations', `${SESSION}${suffix}`)

/** A sign-in on a scratch data folder whose server prints `output` when asked to authenticate,
 *  and saves its checking session as a conversation naming `metaCwd` (its own folder by default);
 *  the browser finishing and that session's answer are each the test's to release. */
async function signInAgainst(
  output: () => Promise<string>,
  options: {
    configure?: (connection: AcpAgentConnection) => void
    stream?: 'stdout' | 'stderr'
    metaCwd?: string
  } = {}
) {
  vi.spyOn(ANTIGRAVITY_LAUNCH_SPEC.managedRuntime, 'pin').mockReturnValue(PIN)
  vi.spyOn(browserHelper, 'antigravityBrowserHelperWorks').mockResolvedValue(true)
  const stateDirectory = await mkdtemp(join(tmpdir(), 'orca-agy-sign-in-'))
  folders.push(stateDirectory)
  const folder = join(stateDirectory, 'antigravity-chat')
  const agent = new AcpScriptedAgent()
  const stderr = new PassThrough()
  const [browserDone, sessionOpen] = [deferred<void>(), deferred<void>()]
  agent.on('authenticate', (frame) => {
    void output().then((text) => (options.stream === 'stdout' ? agent.stdout : stderr).write(text))
    void browserDone.promise.then(() => agent.reply(frame, {}))
  })
  agent.on('session/new', (frame) => {
    void sessionOpen.promise.then(async () => {
      const { cwd } = z.object({ cwd: z.string() }).parse(frame.params)
      await mkdir(join(folder, 'antigravity-acp', 'brain', SESSION), { recursive: true })
      await mkdir(join(folder, 'antigravity-acp', 'conversations'), { recursive: true })
      await writeFile(sessionFile(folder, '.db'), '')
      await writeFile(sessionFile(folder, '.meta'), JSON.stringify({ cwd: options.metaCwd ?? cwd }))
      agent.reply(frame, { sessionId: SESSION })
    })
  })
  const child = fakeServer(agent, stderr)
  // A server on PATH, so nothing is downloaded; the chat server ignores the Command setting.
  const bin = join(stateDirectory, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, ANTIGRAVITY_LAUNCH_SPEC.command), '', { mode: 0o755 })
  const host = {
    launchSources: async () => ({
      accountHome: { variable: 'GEMINI_HOME', path: folder },
      env: { PATH: bin },
      commandSettings: {},
      dataDirectory: stateDirectory
    }),
    stopLiveChats: async () => {},
    connect: vi.fn<ConnectAcpAgent<AcpAgentConnection>>((launch, connectionOptions) => {
      const connection = createAcpAgentConnection(launch, connectionOptions, () => child)
      options.configure?.(connection)
      return connection
    })
  }
  const { flowId } = startAntigravityChatSignIn(host, DESKTOP)
  return {
    agent,
    folder,
    flowId,
    host,
    child,
    stderr,
    finishBrowser: () => browserDone.resolve(),
    openSession: () => sessionOpen.resolve()
  }
}
const printed = (link: string) => async () => `${ANTIGRAVITY_SIGN_IN_PROMPT}${link}\n`

const subscribe = ANTIGRAVITY_ACCOUNT_METHODS[5]

/** Follows the host's sign-in over its subscription, as a client does, until `close`. */
async function follow(
  onFrame: (status: AntigravityChatSignInStatus) => void,
  caller: RpcCallerIdentity = { kind: 'desktop' }
) {
  const transport = new AbortController()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only the caller and the stream registry.
  const ctx = {
    caller,
    signal: transport.signal,
    runtime: {
      registerOwnedSubscriptionCleanup: (_id: string, cleanup: () => void) => ({
        releaseIfCurrent: cleanup
      })
    }
  } as unknown as RpcContext
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this method emits only sign-in status snapshots.
  await subscribe.handler(undefined, ctx, (frame) => onFrame(frame as AntigravityChatSignInStatus))
  return { close: () => transport.abort() }
}

/** The flow's state once it leaves `phase`. */
async function stateAfter(flowId: string, phase: string) {
  const left = Promise.withResolvers<AntigravityChatSignInStatus['flow']>()
  const { close } = await follow(({ flow }) => {
    if (flow?.flowId !== flowId || flow.phase !== phase) {
      left.resolve(flow)
    }
  })
  return left.promise.finally(close)
}

it("shows the helper's link, reads signed in only once a session starts, then removes it", async () => {
  const { agent, folder, flowId, finishBrowser, openSession } = await signInAgainst(() =>
    helperOutput(GOOGLE_LINK)
  )
  const frames: AntigravityChatSignInStatus[] = []
  const watcher = await follow((frame) => frames.push(frame))
  // A full snapshot on subscribe, before any change; nothing has answered on this host yet.
  expect(frames).toEqual([
    { revision: expect.any(Number), auth: 'unknown', flow: expect.anything() }
  ])
  expect(await stateAfter(flowId, 'starting')).toEqual({
    flowId,
    phase: 'waiting',
    url: GOOGLE_LINK
  })
  expect(agent.frames.find((frame) => frame.method === 'authenticate')?.params).toEqual({
    methodId: 'oauth-personal'
  })
  for (const path of [folder, join(folder, 'antigravity-acp')]) {
    expect(process.platform === 'win32' || ((await stat(path)).mode & 0o777) === 0o700).toBe(true)
  }
  finishBrowser()
  expect(await stateAfter(flowId, 'waiting')).toEqual({ flowId, phase: 'verifying' })
  expect(readAntigravityChatSignInStatus(DESKTOP).auth).toBe('unknown')
  openSession()
  expect(await stateAfter(flowId, 'verifying')).toEqual({ flowId, phase: 'signedIn' })
  expect(readAntigravityChatSignInStatus(DESKTOP).auth).toBe('signedIn')
  // Its checking session is gone with the server.
  await expect(stat(sessionFile(folder, '.meta'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(sessionFile(folder, '.db'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(join(folder, 'antigravity-acp', 'brain', SESSION))).rejects.toThrow()
  // Then one frame per newer revision, and none once the transport closes.
  await vi.waitFor(() => expect(frames.at(-1)?.flow).toEqual({ flowId, phase: 'signedIn' }))
  const revisions = frames.map(({ revision }) => revision)
  expect(revisions).toEqual([...new Set(revisions)].sort((a, b) => a - b))
  watcher.close()
  const seen = frames.length
  const next = startAntigravityChatSignIn(
    {
      launchSources: () => Promise.reject(new Error('raw host detail')),
      stopLiveChats: async () => {}
    },
    DESKTOP
  )
  // The person reads a plain sentence; the raw error goes only to the log.
  expect(await stateAfter(next.flowId, 'starting')).toMatchObject({
    phase: 'failed',
    error: 'Google sign-in for Antigravity failed. Start sign-in again.'
  })
  expect(frames).toHaveLength(seen)
})

it('shows another client the sign-in without its link, and refuses it every action', async () => {
  const { flowId, host } = await signInAgainst(printed(GOOGLE_LINK))
  expect(await stateAfter(flowId, 'starting')).toMatchObject({ phase: 'waiting' })
  const phone: AntigravityChatSignInStatus[] = []
  const watcher = await follow((frame) => phone.push(frame), PHONE)
  expect(phone.at(-1)?.flow).toEqual({ flowId: null, phase: 'waiting' })
  expect(() => startAntigravityChatSignIn(host, 'phone')).toThrow('in progress in another client')
  await expect(cancelAntigravityChatSignIn('phone', flowId)).rejects.toThrow('no longer active')
  const pasted = 'http://127.0.0.1:41234/?state=s1&code=c1'
  await expect(completeAntigravityChatSignIn('phone', flowId, pasted)).rejects.toThrow('no longer')
  // Its starter gets the running flow back, and only its starter may cancel it.
  expect(startAntigravityChatSignIn(host, DESKTOP)).toEqual({ flowId })
  expect((await cancelAntigravityChatSignIn(DESKTOP, flowId))?.phase).toBe('cancelled')
  expect(phone.at(-1)?.flow).toEqual({ flowId: null, phase: 'cancelled' })
  watcher.close()
})

it('cancels: its pasted address stops, and no Start runs until the sign-in has unwound', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const arrived = Promise.withResolvers<void>()
  const dropped = Promise.withResolvers<void>()
  // A listener that never answers, so only the flow's end can stop the request.
  const listener = createServer((request) => {
    arrived.resolve()
    request.socket.once('close', () => dropped.resolve())
  })
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address()
  const port = typeof address === 'object' ? address?.port : undefined
  try {
    const { flowId, host } = await signInAgainst(
      printed(GOOGLE_LINK.replace('41234', String(port)))
    )
    expect(await stateAfter(flowId, 'starting')).toMatchObject({ phase: 'waiting' })
    const pasted = `http://127.0.0.1:${port}/?state=s1&code=c1`
    const pasting = completeAntigravityChatSignIn(DESKTOP, flowId, pasted)
    await arrived.promise
    const cancelling = cancelAntigravityChatSignIn(DESKTOP, flowId)
    expect(() => startAntigravityChatSignIn(host, DESKTOP)).toThrow('still stopping')
    expect((await cancelling)?.phase).toBe('cancelled')
    // The paste answers with the cancelled flow, not a delivery failure.
    expect((await pasting)?.phase).toBe('cancelled')
    await dropped.promise
    expect(warn).not.toHaveBeenCalled()
    const next = startAntigravityChatSignIn(
      { launchSources: () => Promise.reject(new Error('x')), stopLiveChats: async () => {} },
      DESKTOP
    )
    expect(await stateAfter(next.flowId, 'starting')).toMatchObject({ phase: 'failed' })
  } finally {
    listener.closeAllConnections()
    listener.close()
  }
})

it('refuses a second, different sign-in link, even while the sign-in is being checked', async () => {
  // The printed line and the helper carry the same link, which is one request.
  const { flowId, finishBrowser, stderr } = await signInAgainst(
    async () => `${await printed(GOOGLE_LINK)()}${await helperOutput(GOOGLE_LINK)}`
  )
  expect(await stateAfter(flowId, 'starting')).toMatchObject({ phase: 'waiting' })
  finishBrowser()
  expect(await stateAfter(flowId, 'waiting')).toEqual({ flowId, phase: 'verifying' })
  stderr.write(await printed(GOOGLE_LINK.replace('state=s1', 'state=s2'))())
  expect(await stateAfter(flowId, 'verifying')).toEqual({
    flowId,
    phase: 'failed',
    error: 'Antigravity started more than one Google sign-in request.'
  })
})

it("sets the host's status from what a chat's server answers, and nothing else", async () => {
  const auth = () => readAntigravityChatSignInStatus(DESKTOP).auth
  const agent = new AcpScriptedAgent()
  const stderr = new PassThrough()
  agent.on('session/new', (frame) => agent.reply(frame, { sessionId: 'chat' }))
  for (const method of ['session/prompt', 'authenticate']) {
    agent.on(method, (frame) => agent.fail(frame, -32000, 'Authentication required'))
  }
  const chat = createAcpAgentConnection(
    { command: 'agy', args: [], cwd: tmpdir() },
    { signIn: ANTIGRAVITY_LAUNCH_SPEC.signIn },
    () => fakeServer(agent, stderr)
  )
  const start = () => chat.start({ cwd: tmpdir(), mcpServers: [] })
  await start()
  expect(auth()).toBe('signedIn')
  await expect(chat.prompt([{ type: 'text', text: 'hi' }])).rejects.toThrow('Authentication')
  expect(auth()).toBe('signedOut')
  await start()
  await expect(chat.authenticate('oauth-personal')).rejects.toThrow('Authentication')
  expect(auth()).toBe('signedOut')
  await start()
  // A broken helper line or a foreign link on error output is no answer.
  stderr.write(`${ANTIGRAVITY_BROWSER_MARKER}"not a link"\n`)
  stderr.write(`${ANTIGRAVITY_SIGN_IN_PROMPT}https://accounts.example.com/\n`)
  await new Promise((resolve) => setImmediate(resolve))
  expect([auth(), chat.closed]).toEqual(['signedOut', false])
  // The printed line, split and left unterminated as the server's last output, still is.
  const line = `${ANTIGRAVITY_SIGN_IN_PROMPT}${GOOGLE_LINK}`
  agent.stdout.write(line.slice(0, 40))
  agent.stdout.end(line.slice(40))
  await vi.waitFor(() => expect([auth(), chat.closed]).toEqual(['signedOut', true]))
})

it("keeps a checking session whose saved folder is not the sign-in's own", async () => {
  const { flowId, folder, host, finishBrowser, openSession } = await signInAgainst(
    printed(GOOGLE_LINK),
    { metaCwd: tmpdir() }
  )
  expect(await stateAfter(flowId, 'starting')).toMatchObject({ phase: 'waiting' })
  finishBrowser()
  openSession()
  await vi.waitFor(() =>
    expect(readAntigravityChatSignInStatus(DESKTOP).flow).toMatchObject({ phase: 'signedIn' })
  )
  const { cwd = '' } = host.connect.mock.calls[0][0]
  await expect(stat(cwd)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await stat(sessionFile(folder, '.meta'))).isFile()).toBe(true)
})

it('signs in from the address a browser on another computer ended on', async () => {
  const received = Promise.withResolvers<string | undefined>()
  let finish = (): void => {}
  // Stands in for the server's own listener, which finishes once Google's answer reaches it.
  const listener = createServer((request, response) => {
    received.resolve(request.url)
    response.end('ok')
    finish()
  })
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address()
  const port = typeof address === 'object' ? address?.port : undefined
  try {
    const link = GOOGLE_LINK.replace('41234', String(port))
    const { flowId, finishBrowser, openSession } = await signInAgainst(printed(link))
    finish = finishBrowser
    expect(await stateAfter(flowId, 'starting')).toMatchObject({ phase: 'waiting' })
    const pasted = `http://127.0.0.1:${port}/?state=s1&code=c1`
    await completeAntigravityChatSignIn(DESKTOP, flowId, pasted)
    expect(await received.promise).toBe('/?state=s1&code=c1')
    await expect(completeAntigravityChatSignIn(DESKTOP, flowId, pasted)).rejects.toThrow(
      'already sent'
    )
    openSession()
    expect(await stateAfter(flowId, 'verifying')).toEqual({ flowId, phase: 'signedIn' })
  } finally {
    listener.close()
  }
})

it('never shows a link that is not a Google sign-in back to this host', async () => {
  const foreign = GOOGLE_LINK.replace('accounts.google.com', 'accounts.example.com')
  // On standard output an unreadable sign-in line ends the server.
  const { flowId } = await signInAgainst(printed(foreign), { stream: 'stdout' })
  const state = await stateAfter(flowId, 'starting')
  expect(state).toMatchObject({ flowId, phase: 'failed' })
  expect(JSON.stringify(state)).not.toContain('example')
  for (const link of [
    GOOGLE_LINK.replace('127.0.0.1', 'attacker.test'),
    GOOGLE_LINK.replace('41234', '80'),
    `${GOOGLE_LINK}&state=s2`
  ]) {
    expect(antigravitySignInUrl(link)).toBeNull()
  }
})

it('retains an unclosed sign-in child for both launch entry points until its exit is proven', async () => {
  const close = vi.fn(async () => false)
  const old = await signInAgainst(printed(GOOGLE_LINK), {
    configure: (connection) => void vi.spyOn(connection, 'close').mockImplementation(close)
  })
  await stateAfter(old.flowId, 'starting')
  old.finishBrowser()
  old.openSession()
  await vi.waitFor(() =>
    expect(readAntigravityChatSignInStatus(DESKTOP).flow).toMatchObject({ phase: 'failed' })
  )
  const launch = old.host.connect.mock.calls[0][0]
  const { env, cwd, envToDelete } = launch
  if (!env || !cwd || !envToDelete) {
    throw new Error('sign-in launch fields missing')
  }
  expect((await stat(env.TMPDIR)).isDirectory()).toBe(true)
  expect((await stat(cwd)).isDirectory()).toBe(true)
  // Its checking session stays until the server is proven gone.
  expect((await stat(sessionFile(old.folder, '.meta'))).isFile()).toBe(true)
  const next = startAntigravityChatSignIn(old.host, DESKTOP)
  expect((await stateAfter(next.flowId, 'starting'))?.phase).toBe('failed')
  expect(old.host.connect).toHaveBeenCalledTimes(1)
  const prepareChat = async () =>
    prepareAcpStructuredLaunch(
      {
        spec: ANTIGRAVITY_LAUNCH_SPEC,
        resolveLaunch: async () => ({
          ...launch,
          env,
          cwd,
          envToDelete: [...envToDelete],
          spec: ANTIGRAVITY_LAUNCH_SPEC,
          fullAccess: false,
          resume: null
        })
      },
      {
        identity: {
          sessionId: 'retry-chat',
          workspaceId: 'folder',
          hostId: 'local',
          agent: 'antigravity',
          providerHandle: null
        },
        spawnToken: 'retry-chat'
      },
      () => {}
    )
  const gate = ANTIGRAVITY_LAUNCH_SPEC.launchGate.enter(undefined)
  const spawnChat = vi.fn()
  try {
    await expect(prepareChat().then(spawnChat)).rejects.toThrow('could not be stopped')
    expect(close).toHaveBeenCalledTimes(3)
    close.mockImplementationOnce(async () => {
      old.child.emit('exit', 0, null)
      return true
    })
    spawnChat(await prepareChat())
    expect(spawnChat).toHaveBeenCalledTimes(1)
  } finally {
    gate.leave()
  }
  await vi.waitFor(async () => {
    await expect(stat(env.TMPDIR)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(cwd)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(sessionFile(old.folder, '.meta'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

it('fails without downloading anything while the server is not installed', async () => {
  vi.spyOn(ANTIGRAVITY_LAUNCH_SPEC.managedRuntime, 'pin').mockReturnValue(PIN)
  const dataDirectory = await mkdtemp(join(tmpdir(), 'orca-agy-sign-in-'))
  folders.push(dataDirectory)
  const connect = vi.fn<ConnectAcpAgent<AcpAgentConnection>>()
  const { flowId } = startAntigravityChatSignIn(
    {
      launchSources: async () => ({
        accountHome: { variable: 'GEMINI_HOME', path: join(dataDirectory, 'antigravity-chat') },
        env: { PATH: join(dataDirectory, 'empty-bin') },
        commandSettings: {},
        dataDirectory
      }),
      stopLiveChats: async () => {},
      connect
    },
    DESKTOP
  )
  const state = await stateAfter(flowId, 'starting')
  expect(state).toMatchObject({ phase: 'failed', error: expect.stringContaining('not installed') })
  expect(connect).not.toHaveBeenCalled()
})

it('expires a waiting sign-in quietly and releases its launch gate', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const { flowId } = await signInAgainst(printed(GOOGLE_LINK))
    expect(await stateAfter(flowId, 'starting')).toMatchObject({ phase: 'waiting' })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(readAntigravityChatSignInStatus(DESKTOP).flow).toMatchObject({ phase: 'expired' })
    await vi.waitFor(() => {
      const entry = ANTIGRAVITY_LAUNCH_SPEC.launchGate!.enter(undefined)
      entry.leave()
    })
    expect(warn).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})
