import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import type { ProcessSpec } from '@orca/process-host/process-spec'

import {
  openClaudeStreamJsonConnection,
  type ClaudeStreamJsonConnection,
  type ClaudeStreamJsonLaunch
} from '../claude-stream-json-connection'
import { CLAUDE_STRUCTURED_BASE_OPTIONS } from '../structured/launch/claude-structured-launch-resolution'
import { ClaudeStructuredSessionAdapter } from '../structured/claude-structured-session-adapter'
import type { ClaudeStructuredSessionEvent } from '../structured/claude-structured-session-state'
import { DaemonServer } from '../../daemon/server/daemon-server'
import { DaemonClient } from '../../daemon/transport/client/daemon-client'
import { installProviderProcessHost } from '../../provider-process/provider-process-spawn'
import * as identityProbe from '../../runtime/agent-session/ownership/agent-session-process-identity-probe'

vi.mock('../../daemon/executable-host/macos/daemon-mac-code-identity', () => ({
  inspectMacProcessCodeIdentity: vi.fn(async () => ({
    identity: 'resolved',
    executablePath: '/fake/Orca Agents'
  }))
}))

// Exercise the real SDK against a scripted child CLI.
const FAKE_CLI = join(__dirname, '../__fixtures__', 'claude-agent-sdk-scripted-cli.mjs')
const SESSION_ID = '5348c19f-6a54-4c2e-9c68-9c2b1a3d4e5f'
const HOLD_OPEN = { delayMs: 10_000 }

type ScriptedCliReport = {
  argv: string[]
  controlRequests: { request_id: string; request: { subtype: string } }[]
  controlResponses: { response: { request_id: string; response?: unknown } }[]
  userMessages: Record<string, unknown>[]
  descendantPid: number | null
}

const scratchDirs: string[] = []
const openConnections: ClaudeStreamJsonConnection[] = []
const childClosures: Promise<void>[] = []

afterEach(async () => {
  for (const connection of openConnections.splice(0)) {
    await connection.close()
  }
  await Promise.all(childClosures.splice(0))
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
  spawned.splice(0)
  spawnedChildren.splice(0)
  vi.unstubAllEnvs()
})

function scriptScenario(
  steps: Record<string, unknown>[],
  controlResponses: Record<string, unknown> = {}
) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-sdk-connection-'))
  scratchDirs.push(dir)
  const scenarioPath = join(dir, 'scenario.json')
  const reportPath = join(dir, 'report.json')
  writeFileSync(scenarioPath, JSON.stringify({ steps, controlResponses }))
  return {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? '',
      ORCA_SDK_CONTRACT_SCENARIO_PATH: scenarioPath,
      ORCA_SDK_CONTRACT_REPORT_PATH: reportPath
    },
    readReport: () => JSON.parse(readFileSync(reportPath, 'utf8')) as ScriptedCliReport
  }
}

function launchFor(
  scenario: { cwd: string; env: Record<string, string> },
  env: Record<string, string> = {}
): ClaudeStreamJsonLaunch {
  return {
    pathToClaudeCodeExecutable: FAKE_CLI,
    options: { ...CLAUDE_STRUCTURED_BASE_OPTIONS, sessionId: SESSION_ID },
    cwd: scenario.cwd,
    env: { ...scenario.env, ...env }
  }
}

const spawned: ProcessSpec[] = []
const spawnedChildren: ChildProcess[] = []

async function open(
  launch: ClaudeStreamJsonLaunch,
  handlers: Parameters<typeof openClaudeStreamJsonConnection>[1] = {}
): Promise<ClaudeStreamJsonConnection> {
  const connection = await openClaudeStreamJsonConnection(launch, handlers, (spec) => {
    spawned.push(spec)
    const child = spawnProcess(spec)
    spawnedChildren.push(child)
    childClosures.push(new Promise<void>((resolve) => child.once('close', () => resolve())))
    return child
  })
  openConnections.push(connection)
  return connection
}

describe('Claude stream-json connection', () => {
  it('hands acquisition the actual connection before a pending startup can reject', async () => {
    const scenario = scriptScenario([HOLD_OPEN])
    const ready = Promise.withResolvers<void>()
    const retained = Promise.withResolvers<ClaudeStreamJsonConnection>()
    const opening = openClaudeStreamJsonConnection(
      launchFor(scenario),
      {
        onConnection: (connection) => retained.resolve(connection)
      },
      (spec) => {
        const child = spawnProcess(spec)
        spawnedChildren.push(child)
        childClosures.push(new Promise<void>((resolve) => child.once('close', () => resolve())))
        return Object.assign(child, { ready: ready.promise })
      }
    )
    const rejected = expect(opening).rejects.toThrow('pending startup failed')
    const connection = await retained.promise
    openConnections.push(connection)
    ready.reject(new Error('pending startup failed'))
    await rejected
    await expect(connection.close()).resolves.toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    'retires hosted active and idle sessions after proven root absence and permits a fresh send',
    async () => {
      const scenario = scriptScenario([
        { emit: { type: 'system', subtype: 'init', session_id: SESSION_ID, uuid: 'init' } },
        { awaitUserMessage: true },
        {
          emit: {
            type: 'user',
            session_id: SESSION_ID,
            uuid: 'echo',
            parent_tool_use_id: null,
            message: { role: 'user', content: [{ type: 'text', text: 'first' }] }
          }
        },
        { delayMs: 60_000 }
      ])
      const server = new DaemonServer({
        socketPath: join(scenario.cwd, 'daemon.sock'),
        tokenPath: join(scenario.cwd, 'token'),
        providerSpawn: true,
        spawnSubprocess: () => {
          throw new Error('No PTY in hosted Claude fixture')
        }
      })
      const client = new DaemonClient({
        socketPath: join(scenario.cwd, 'daemon.sock'),
        tokenPath: join(scenario.cwd, 'token')
      })
      const nonces: string[] = []
      let liveObserved = false
      const disconnected = new Set<() => void>()
      vi.spyOn(client, 'onDisconnected').mockImplementation((listener) => {
        disconnected.add(listener)
        return () => disconnected.delete(listener)
      })
      const events: ClaudeStructuredSessionEvent[] = []
      const probe = identityProbe.probeAgentSessionProcessIdentity
      vi.spyOn(identityProbe, 'probeAgentSessionProcessIdentity').mockImplementation(
        async (input) => {
          const proof = await probe(input)
          if (proof.outcome !== 'pid-absent') {
            liveObserved = true
          }
          return proof
        }
      )
      const request = client.request.bind(client)
      const querySpy = vi.spyOn(client, 'request').mockImplementation(function <T>(
        ...args: Parameters<typeof request>
      ): Promise<T> {
        // A restarted host has no retained outcome; use a real unknown-nonce query while keeping held signal authority.
        return args[0] === 'queryProvider'
          ? request<T>('queryProvider', { nonce: 'f'.repeat(64) })
          : request<T>(...args)
      })
      const exitSpy = vi.spyOn(client, 'onProviderExit').mockImplementation((nonce) => {
        nonces.push(nonce)
        return () => {}
      })
      const adapter = new ClaudeStructuredSessionAdapter({
        resolveLaunch: async () => ({
          ...launchFor(scenario, { ORCA_SDK_CONTRACT_TIMEOUT_MS: '60000' }),
          claudeConfigDir: scenario.cwd,
          providerSessionId: SESSION_ID,
          resumeLeafUuid: null,
          resumesTranscript: false,
          continuesChain: false,
          cliFlag: async () => 'supported'
        }),
        onEvent: (event) => {
          events.push(event)
        }
      })
      const acquire = (sessionId: string, fence = 1) =>
        adapter.acquire({
          identity: {
            sessionId,
            workspaceId: 'hosted-fixture',
            hostId: 'local',
            agent: 'claude',
            providerHandle: null
          },
          fence,
          spawnToken: `spawn-${sessionId}-${fence}`
        })
      const dispatch = (sessionId: string, clientMessageId: string, fence = 1) =>
        adapter.dispatch({
          sessionId,
          clientMessageId,
          fence,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'first' }] }
        })
      try {
        await server.start()
        await client.ensureConnected()
        installProviderProcessHost(async () => client)
        await acquire('active')
        await acquire('idle')
        await dispatch('active', 'before-loss')
        client.disconnect()
        for (const listener of disconnected) {
          listener()
        }
        await vi.waitFor(() => expect(liveObserved).toBe(true), { timeout: 5_000 })
        expect(events.filter((event) => event.type === 'ended')).toEqual([])
        await client.ensureConnected()
        for (const nonce of nonces) {
          await expect(
            client.request('signalProvider', { nonce, signal: 'SIGTERM' })
          ).resolves.toEqual({
            delivered: true
          })
        }
        await vi.waitFor(
          () => expect(events.filter((event) => event.type === 'ended')).toHaveLength(2),
          { timeout: 5_000 }
        )
        await adapter.drainObservedExits()
        expect(
          events
            .filter((event) => event.type === 'ended')
            .map((event) => event.sessionId)
            .sort()
        ).toEqual(['active', 'idle'])
        querySpy.mockRestore()
        exitSpy.mockRestore()
        events.length = 0
        await acquire('active', 2)
        await expect(dispatch('active', 'after-loss', 2)).resolves.toMatchObject({
          state: 'admitted'
        })
        await vi.waitFor(
          () =>
            expect(events).toContainEqual(
              expect.objectContaining({
                type: 'message',
                sessionId: 'active',
                message: expect.objectContaining({ type: 'user', uuid: 'echo' })
              })
            ),
          { timeout: 5_000 }
        )
      } finally {
        querySpy.mockRestore()
        exitSpy.mockRestore()
        try {
          await adapter.closeAll()
        } finally {
          installProviderProcessHost(async () => null)
          await server.shutdown()
          client.disconnect()
          vi.restoreAllMocks()
        }
      }
    }
  )

  it('completes task Stop through the real SDK while semantic reading is paused', async () => {
    const scenario = scriptScenario([HOLD_OPEN])
    const connection = await open(launchFor(scenario))
    await connection.initializationResult()
    connection.pauseReading?.()
    await connection.stopTask('owned-shell')
    expect(scenario.readReport().controlRequests).toContainEqual(
      expect.objectContaining({
        request: expect.objectContaining({ subtype: 'stop_task', task_id: 'owned-shell' })
      })
    )
    connection.resumeReading?.()
  })
})
