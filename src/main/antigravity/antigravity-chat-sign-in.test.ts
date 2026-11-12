import type { AntigravityChatAuthConfig } from '../../shared/antigravity-chat-auth-config'
import { structuredAgentHostLaunchSources } from '../runtime/agent-session/launch/structured-agent-launch-support'
import * as profileStorage from '../orca-profiles/profile-storage-paths'
// The chat sign-in against a scripted Antigravity server.

import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import type { terminateProviderProcessTree } from '../provider-process/provider-process-teardown'
import {
  createAcpAgentConnection,
  type AcpAgentConnection
} from '../acp/process/acp-agent-connection'
import { ANTIGRAVITY_LAUNCH_SPEC } from './antigravity-acp-launch-spec'

import type { ConnectAcpAgent } from '../acp/process/acp-structured-connection'
import { AcpScriptedAgent, deferred } from '../acp/process/testing/acp-scripted-agent.test-support'
import type { RpcContext } from '../runtime/rpc/core'
import type { RpcCallerIdentity } from '../runtime/rpc/callers/rpc-caller-identity'
import { ANTIGRAVITY_ACCOUNT_METHODS } from '../runtime/rpc/methods/accounts/antigravity-accounts'
import type { AntigravityChatSignInStatus } from '../../shared/antigravity-account-types'

import * as browserHelper from './antigravity-browser-helper'
import { ANTIGRAVITY_SIGN_IN_PROMPT } from './antigravity-sign-in-url'
import {
  cancelAntigravityChatSignIn,
  completeAntigravityChatSignIn,
  startAntigravityChatSignIn
} from './antigravity-chat-sign-in'

vi.mock('../provider-process/provider-process-teardown', () => ({
  terminateProviderProcessTree: vi.fn<typeof terminateProviderProcessTree>(
    async () => 'unverifiable'
  )
}))

const checkingShell = vi.hoisted(() => ({ path: '/fixture', next: '/fixture' }))
vi.mock('../startup/login-shell-environment', () => ({
  resolveLoginShellEnvironment: async (options?: { startedAfter?: number }) => {
    if (options?.startedAfter !== undefined) {
      checkingShell.path = checkingShell.next
    }
    return { PATH: checkingShell.path }
  }
}))

const GOOGLE_LINK =
  'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=s1&redirect_uri=http%3A%2F%2F127.0.0.1%3A41234%2F'
// Use a fake pin even on hosts without a published server build.
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

const sessionFile = (folder: string, suffix: string) =>
  join(folder, 'antigravity-acp', 'conversations', `${SESSION}${suffix}`)

/** The test releases browser authentication and session creation independently. */
async function signInAgainst(
  output: () => Promise<string>,
  options: {
    configure?: (connection: AcpAgentConnection) => void
    stream?: 'stdout' | 'stderr'
    metaCwd?: string
    sessionResult?: Record<string, unknown>
    authConfig?: AntigravityChatAuthConfig
    realLaunchSources?: boolean
  } = {}
) {
  vi.spyOn(ANTIGRAVITY_LAUNCH_SPEC.managedRuntime, 'pin').mockReturnValue(PIN)
  vi.spyOn(browserHelper, 'antigravityBrowserHelperWorks').mockResolvedValue(true)
  // Short on POSIX so the private temp root stays in this folder, not /tmp/oacp-*.
  const stateDirectory = await mkdtemp(
    process.platform === 'win32' ? join(tmpdir(), 'orca-agy-sign-in-') : '/tmp/o'
  )
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
      agent.reply(frame, { ...options.sessionResult, sessionId: SESSION })
    })
  })
  const child = fakeServer(agent, stderr)
  // Satisfy runtime resolution from PATH without downloading.
  const bin = join(stateDirectory, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, ANTIGRAVITY_LAUNCH_SPEC.command), '', { mode: 0o755 })
  if (options.realLaunchSources) {
    checkingShell.path = bin
    checkingShell.next = bin
    vi.spyOn(profileStorage, 'getProfileUserDataPath').mockReturnValue(stateDirectory)
  }
  const host = {
    launchSources: options.realLaunchSources
      ? (signal: AbortSignal) =>
          structuredAgentHostLaunchSources(
            'antigravity',
            {
              requireStore: () => ({
                getSettings: () => ({
                  nativeChatInheritShellEnvironment: true,
                  agentDefaultEnv: {},
                  antigravityChatAuth: options.authConfig
                })
              }),
              resolveStructuredAgentAccountHome: async () => ({
                variable: 'GEMINI_HOME',
                path: folder
              })
            },
            signal
          )
      : async () => ({
          accountHome: { variable: 'GEMINI_HOME', path: folder },
          env: { PATH: bin },
          commandSettings: { antigravityChatAuth: options.authConfig },
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

async function stateAfter(flowId: string, phase: string) {
  const left = Promise.withResolvers<AntigravityChatSignInStatus['flow']>()
  const { close } = await follow(({ flow }) => {
    if (flow?.flowId !== flowId || flow.phase !== phase) {
      left.resolve(flow)
    }
  })
  return left.promise.finally(close)
}

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
  expect(startAntigravityChatSignIn(host, DESKTOP)).toEqual({ flowId })
  expect((await cancelAntigravityChatSignIn(DESKTOP, flowId))?.phase).toBe('cancelled')
  expect(phone.at(-1)?.flow).toEqual({ flowId: null, phase: 'cancelled' })
  watcher.close()
})

it('cancels: its pasted address stops, and no Start runs until the sign-in has unwound', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const arrived = Promise.withResolvers<void>()
  const dropped = Promise.withResolvers<void>()
  // Leave the request pending until cancellation aborts it.
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

it('signs in from the address a browser on another computer ended on', async () => {
  const received = Promise.withResolvers<string | undefined>()
  let finish = (): void => {}
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
