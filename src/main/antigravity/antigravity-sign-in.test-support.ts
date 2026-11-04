import { structuredAgentHostLaunchSources } from '../runtime/structured-agent-launch-support'
import * as profileStorage from '../orca-profiles/profile-storage-paths'
// The chat sign-in against a scripted Antigravity server.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, vi } from 'vitest'
import { z } from 'zod'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { createAcpAgentConnection, type AcpAgentConnection } from '../acp/acp-agent-connection'
import { ANTIGRAVITY_LAUNCH_SPEC } from '../acp/acp-launch-specs'
import type { ConnectAcpAgent } from '../acp/acp-structured-connection'
import { AcpScriptedAgent, deferred } from '../acp/acp-scripted-agent.test-support'
import type { RpcContext } from '../runtime/rpc/core'
import type { RpcCallerIdentity } from '../runtime/rpc/rpc-caller-identity'
import { ANTIGRAVITY_ACCOUNT_METHODS } from '../runtime/rpc/methods/antigravity-accounts'
import type {
  AntigravityChatSignInIntent,
  AntigravityChatSignInStatus
} from '../../shared/antigravity-account-types'
import { ANTIGRAVITY_BROWSER_MARKER } from './antigravity-browser-helper'
import * as browserHelper from './antigravity-browser-helper'
import { ANTIGRAVITY_SIGN_IN_PROMPT } from './antigravity-sign-in-url'
import {
  cancelAntigravityChatSignIn,
  readAntigravityChatSignInStatus,
  startAntigravityChatSignIn
} from './antigravity-chat-sign-in'

const checkingShell = { path: '/fixture', next: '/fixture' }

// Use a fake pin even on hosts without a published server build.
const PIN = {
  version: '1.4.1',
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
  const flow = readAntigravityChatSignInStatus(DESKTOP).flow
  if (flow?.flowId && ['starting', 'waiting', 'verifying'].includes(flow.phase)) {
    await cancelAntigravityChatSignIn(DESKTOP, flow.flowId)
  }
  await vi.waitFor(() => ANTIGRAVITY_LAUNCH_SPEC.launchGate.enter(undefined).leave())
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

async function helperOutput(link: string): Promise<string> {
  return `${ANTIGRAVITY_BROWSER_MARKER}${JSON.stringify(link)}\n`
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
    realLaunchSources?: boolean
    cachedToken?: string
    sessionError?: boolean
    intent?: AntigravityChatSignInIntent
  } = {}
) {
  vi.spyOn(ANTIGRAVITY_LAUNCH_SPEC.managedRuntime, 'pin').mockReturnValue(PIN)
  vi.spyOn(browserHelper, 'antigravityBrowserHelperWorks').mockResolvedValue(true)
  const stateDirectory = await mkdtemp(join(tmpdir(), 'orca-agy-sign-in-'))
  folders.push(stateDirectory)
  const folder = join(stateDirectory, 'antigravity-chat')
  await mkdir(join(folder, 'antigravity-acp'), { recursive: true })
  if (options.cachedToken) {
    await writeFile(join(folder, 'antigravity-acp', 'acp_token.json'), options.cachedToken)
  }
  let serverHome = folder
  const agent = new AcpScriptedAgent()
  const stderr = new PassThrough()
  const [browserDone, sessionOpen] = [deferred<void>(), deferred<void>()]
  agent.on('authenticate', (frame) => {
    void (async () => {
      const token = join(serverHome, 'antigravity-acp', 'acp_token.json')
      if (await readFile(token).catch(() => null)) {
        agent.reply(frame, {})
        sessionOpen.resolve()
        return
      }
      const text = await output()
      ;(options.stream === 'stdout' ? agent.stdout : stderr).write(text)
      await browserDone.promise
      if (!child.stdin.writableEnded) {
        await writeFile(token, 'replacement-token')
        agent.reply(frame, {})
      }
    })()
  })
  agent.on('session/new', (frame) => {
    void sessionOpen.promise.then(async () => {
      if (child.stdin.writableEnded) {
        return
      }
      const { cwd } = z.object({ cwd: z.string() }).parse(frame.params)
      if (options.sessionError) {
        agent.fail(frame, -32603, 'fixture session failure')
        return
      }
      await mkdir(join(serverHome, 'antigravity-acp', 'brain', SESSION), { recursive: true })
      await mkdir(join(serverHome, 'antigravity-acp', 'conversations'), { recursive: true })
      await writeFile(sessionFile(serverHome, '.db'), '')
      await writeFile(
        sessionFile(serverHome, '.meta'),
        JSON.stringify({ cwd: options.metaCwd ?? cwd })
      )
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
                  agentDefaultEnv: {}
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
          commandSettings: {},
          dataDirectory: stateDirectory
        }),
    stopLiveChats: async () => {},
    connect: vi.fn<ConnectAcpAgent<AcpAgentConnection>>((launch, connectionOptions) => {
      serverHome = launch.env?.GEMINI_HOME ?? folder
      const connection = createAcpAgentConnection(launch, connectionOptions, () => child)
      options.configure?.(connection)
      return connection
    })
  }
  const { flowId } = startAntigravityChatSignIn(host, DESKTOP, options.intent ?? 'changeAccount')
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

export {
  PIN,
  SESSION,
  DESKTOP,
  PHONE,
  folders,
  checkingShell,
  fakeServer,
  helperOutput,
  signInAgainst,
  printed,
  follow,
  stateAfter
}
