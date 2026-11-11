import { readTestHostJournal } from '../../native-chat/agent-session-journal/journal-observation.test-support'
import './unused-default-rpc-methods.test-fixture'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { activeProviderContext } from '../../../shared/agent-session/agent-session-provider-context'
import { isOrcaSessionId } from '../../../shared/orca-session-address'
import { getRuntimeMetadataPath } from '../../../shared/runtime-bootstrap'
import { structuredAgentSessionTabId } from '../../../shared/agent-session/view/structured-agent-session-projection'
import * as versionProbe from '../../agent-launch/preflight/agent-cli-version-probe'
import { createStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { CODEX_MINIMUM_SUPPORTED_VERSION } from '../../../shared/codex-cli-installation'
import { CodexAppServerRequestError } from '../../codex/app-server/codex-app-server-request-error'

import { OrchestrationDb } from '../orchestration/db/orchestration-db'
import '../orchestration/db/contract-constants'
import '../orchestration/db/messages/mailbox-routing-page'
import '../orchestration/db/dispatch-row-writer'
import '../orchestration/db/attempt-outcome-projection'

import { scriptedCodexTransport } from '../orca-runtime-tests/scripted-codex-transport.test-fixture'
import { chatTabCommandsSettled } from '../orca-runtime-tests/session-layout-apply.test-fixture'
import {
  AuthorityRuntime,
  authorityProfile,
  root,
  savedIds
} from '../agent-session/lifecycle/structured-agent-session-tab-authority.test-support'
import { ensureTestStructuredAgentSessionHost as ensureStructuredAgentSessionHost } from '../agent-session/records/agent-session-record-store-test-harness'
import {
  fakeCodex,
  resetProviderFaults
} from '../orchestration/terminal-authority/structured-sessions/structured-chat-coordinator-fake-codex-fixture'
import { structuredWorkerIdentities } from '../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import { releaseStructuredWorkerSession } from './methods/orchestration/structured-workers/orchestration-structured-worker-session'
import { AGENT_LAUNCH_METHODS } from './methods/agent-launch/agent-launch'
import { ORCHESTRATION_METHODS } from './methods/orchestration/orchestration'
import { STATUS_METHODS } from './methods/host-management/status'
import { WORKTREE_METHODS } from './methods/workspaces/worktree'
import { REPO_METHODS } from './methods/projects/repo'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { isRecord, resultOf } from './orchestration-session-caller-test-fixture'
import { UnixSocketTransport } from './unix-socket-transport'
import { removalPtyProvider } from './worktree-rm-pty.test-fixture'

const cliPath = '../../../cli/index'
const { main }: { main: (argv: string[], cwd: string) => Promise<void> } = await import(cliPath)
let rig: Awaited<ReturnType<typeof authorityProfile>>
let runtime: AuthorityRuntime
let host: StructuredAgentSessionHost
let db: OrchestrationDb
let codex: ReturnType<typeof fakeCodex>
let socket: UnixSocketTransport | undefined
let runId: string
let finishTurns = true
let rejectNextTurn = false
const dispatches: string[] = []
const requests: RpcRequest[] = []

beforeEach(async () => {
  resetProviderFaults()
  finishTurns = true
  rejectNextTurn = false
  rig = await authorityProfile([])
  await mkdir(join(root, 'codex-home'))
  rig.profile.updateSettings({
    agentDefaultSurface: 'chat',
    nativeChatInheritShellEnvironment: false,
    agentCmdOverrides: { codex: process.execPath },
    agentWorkspaceTrustEnabled: false
  })
  runtime = new AuthorityRuntime(rig.profile, undefined, {
    prepareCodexStructuredLaunch: () => join(root, 'codex-home')
  })
  db = new OrchestrationDb(':memory:')
  runtime.setOrchestrationDb(db)
  codex = fakeCodex()
  vi.spyOn(versionProbe, 'checkAgentCliVersion').mockResolvedValue({
    status: 'ready',
    version: CODEX_MINIMUM_SUPPORTED_VERSION
  })
  const openConnection: typeof codex.openConnection = async (...args) => {
    const connection = await codex.openConnection(...args)
    const request = connection.request.bind(connection)
    connection.request = async (method, params) => {
      if (method === 'turn/start' && rejectNextTurn) {
        rejectNextTurn = false
        throw new CodexAppServerRequestError('turn/start', -32000, 'Task refused', 'Task refused')
      }
      const response = await request(method, params)
      if (
        method === 'turn/start' &&
        isRecord(params) &&
        isRecord(response) &&
        isRecord(response.turn)
      ) {
        const turnId = response.turn.id
        const clientUserMessageId = params.clientUserMessageId
        if (typeof turnId !== 'string' || typeof clientUserMessageId !== 'string') {
          throw new Error('expected string turn and user message identities')
        }
        setTimeout(() => {
          args[1]?.onNotification?.('turn/started', { turn: { id: turnId } })
          args[1]?.onNotification?.('item/completed', {
            item: {
              type: 'userMessage',
              id: `echo-${clientUserMessageId}`,
              clientId: clientUserMessageId,
              content: [{ type: 'text', text: 'CLI worker brief' }]
            }
          })
          args[1]?.onNotification?.('item/completed', {
            item: {
              type: 'agentMessage',
              id: `answer-${turnId}`,
              text: 'READY from bounded provider'
            }
          })
          if (finishTurns) {
            args[1]?.onNotification?.('turn/completed', { turn: { id: turnId } })
          }
        }, 0)
      }
      return response
    }
    return connection
  }
  host = await ensureStructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'cli-test',
    resolveWorkspacePath: async () => root,
    resolveCodexCommand: () => ({ command: process.execPath, prefixArgs: [] }),
    resolveLaunchArgs: () => [],
    resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
    resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
    ...scriptedCodexTransport(openConnection),
    onRequestFailure: (failure) => runtime.onStructuredRequestFailureForErrorMail(failure),
    onSessionStatusChanged: (summary) => runtime.onStructuredSessionStatusForMail(summary),
    onSessionTabHidden: (id) => runtime.onStructuredSessionTabHidden(id)
  })
  vi.spyOn(runtime, 'getLocalProvider').mockReturnValue(removalPtyProvider([]).provider)
  for (const key of [
    'ORCA_PAIRING_CODE',
    'ORCA_ENVIRONMENT',
    'ORCA_TERMINAL_HANDLE',
    'ORCA_PANE_KEY',
    'ORCA_AGENT_SESSION_ID',
    'ORCA_ORCHESTRATION_RUN_ID'
  ]) {
    vi.stubEnv(key, undefined)
  }
  vi.stubEnv('ORCA_USER_DATA_PATH', root)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: [
      ...STATUS_METHODS,
      ...WORKTREE_METHODS,
      ...REPO_METHODS,
      ...AGENT_LAUNCH_METHODS,
      ...ORCHESTRATION_METHODS
    ]
  })
  requests.length = 0
  const kind = process.platform === 'win32' ? 'named-pipe' : 'unix'
  const endpoint =
    process.platform === 'win32'
      ? String.raw`\\.\pipe\orca-structured-cli-${randomUUID()}`
      : join(root, 'rpc.sock')
  socket = new UnixSocketTransport({ kind, endpoint })
  socket.onMessage((message, reply) => {
    const request: RpcRequest = JSON.parse(message)
    requests.push(request)
    void dispatcher.dispatch(request).then((response) => reply(JSON.stringify(response)))
  })
  await socket.start()
  await writeFile(
    getRuntimeMetadataPath(root),
    JSON.stringify({
      runtimeId: runtime.getRuntimeId(),
      pid: process.pid,
      transports: [{ kind, endpoint }],
      authToken: 'test',
      startedAt: 1
    })
  )
})

afterEach(async () => {
  for (const dispatch of dispatches.splice(0)) {
    releaseStructuredWorkerSession(dispatch, runtime)
  }
  await socket?.stop()
  socket = undefined
  db?.close()
  structuredWorkerIdentities.clear()
  vi.unstubAllEnvs()
  process.exitCode = 0
})

async function cli(argv: string[]) {
  vi.mocked(console.log).mockClear()
  vi.mocked(console.error).mockClear()
  process.exitCode = 0
  await main([...argv, '--json', ...(argv[0] === 'orchestration' ? ['--full'] : [])], root)
  const stdout = vi
    .mocked(console.log)
    .mock.calls.map(([line]) => String(line))
    .join('\n')
  const stderr = vi
    .mocked(console.error)
    .mock.calls.map(([line]) => String(line))
    .join('\n')
  const output: unknown = JSON.parse(stdout)
  return { output, code: process.exitCode, stdout, stderr }
}

async function launch() {
  const receipt = await cli([
    'agent',
    'launch',
    '--agent',
    'codex',
    '--worktree',
    `id:${rig.workspace}`,
    '--surface',
    'chat',
    '--prompt',
    'Coordinator'
  ])
  expect(receipt.code, receipt.stdout + receipt.stderr).toBe(0)
  const result = resultOf(receipt.output)
  const ids = host.deps.store.getVisibleSessionTabIndex().sessionIds
  expect(ids).toHaveLength(1)
  const sessionId = ids[0]!
  expect(isOrcaSessionId(sessionId)).toBe(true)
  if (!isOrcaSessionId(sessionId)) {
    throw new Error('invalid created session identity')
  }
  expect(result).toMatchObject({
    worktreeId: rig.workspace,
    outcome: { kind: 'structured', sessionId }
  })
  vi.stubEnv('ORCA_AGENT_SESSION_ID', sessionId)
  runId = db.createRun({
    objective: 'CLI lifecycle',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: sessionId
  }).id
  await chatTabCommandsSettled()
  await vi.waitFor(async () => {
    expect((await readTestHostJournal(host, sessionId)).submissions).toMatchObject([
      { dispatchState: 'accepted' }
    ])
  })
  expect(savedIds(rig)).toContain(sessionId)
  return { result, sessionId }
}

async function start(retryOf?: string) {
  const receipt = await cli([
    'orchestration',
    'worker-start',
    '--run',
    runId,
    '--worktree',
    `id:${rig.workspace}`,
    '--agent',
    'codex',
    ...(retryOf
      ? ['--task', db.getDispatchContextById(retryOf)!.task_id, '--retry-of', retryOf]
      : ['--spec', 'Reply once then wait'])
  ])
  expect(receipt.code, receipt.stdout + receipt.stderr).toBe(0)
  const result = resultOf(receipt.output)
  expect(result).toMatchObject({ state: 'ready', mode: { mode: 'structured' } })
  if (typeof result.dispatchId !== 'string' || typeof result.taskId !== 'string') {
    throw new Error('worker-start did not return dispatch/task identities')
  }
  const dispatchId = result.dispatchId
  const taskId = result.taskId
  dispatches.push(dispatchId)
  const worker = db.getWorkerDispatch(dispatchId)!
  const identity = structuredWorkerIdentities.get(worker.agent_terminal_handle!)
  if (!identity) {
    throw new Error('worker identity not registered')
  }
  const record = host.deps.store.getRecord(identity.sessionId)!
  const nativeId = activeProviderContext(record).head?.handle.nativeId
  const connection = codex.connections.find((c) => c.threadId === nativeId)
  if (!connection) {
    throw new Error('worker provider not started')
  }
  await chatTabCommandsSettled()
  expect(savedIds(rig)).toContain(identity.sessionId)
  expect(runtime.live(identity.sessionId)).toBe(true)
  return { result, dispatchId, taskId, worker, identity, connection }
}

function visible(sessionId: string, expected: boolean) {
  expect(host.deps.store.getVisibleSessionTabIndex().sessionIds.includes(sessionId)).toBe(expected)
  expect(runtime.live(sessionId)).toBe(expected)
  expect(savedIds(rig).includes(sessionId)).toBe(expected)
}

async function selectSurvivor(sessionId: string) {
  const session = rig.profile.getWorkspaceSession('local')
  if (!session) {
    throw new Error('missing saved workspace session')
  }
  const tabId = structuredAgentSessionTabId(sessionId)
  rig.profile.setWorkspaceSession({
    ...session,
    activeWorktreeId: rig.workspace,
    activeTabId: tabId,
    activeTabIdByWorktree: { ...session.activeTabIdByWorktree, [rig.workspace]: tabId }
  })
  await rig.profile.flushPendingOrThrowAsync()
  return () => {
    const current = rig.profile.getWorkspaceSession('local')
    expect(current?.activeWorktreeId).toBe(rig.workspace)
    expect(current?.activeTabId).toBe(tabId)
    expect(current?.activeTabIdByWorktree?.[rig.workspace]).toBe(tabId)
  }
}

function settle(worker: Awaited<ReturnType<typeof start>>) {
  expect(
    db.settleWorkerReport({
      taskId: worker.taskId,
      dispatchId: worker.dispatchId,
      outcome: 'succeeded',
      result: JSON.stringify({ summary: 'Completed fixture task' })
    })
  ).toMatchObject({ action: 'settled' })
  expect(db.getWorkerDispatch(worker.dispatchId)?.state).toBe('succeeded')
  expect(worker.connection.closed).toBe(false)
  expect(db.getWorkerTerminalResourceByOwner(worker.dispatchId)).toMatchObject({
    ownership_state: 'owned'
  })
}

it.each(['worker-stop', 'worker-release'] as const)(
  '%s waits for provider proof before CLI success and exact raw/saved retirement',
  async (command) => {
    const survivor = await launch()
    const worker = await start()
    if (command === 'worker-release') {
      settle(worker)
    }
    const selectionPreserved = await selectSurvivor(survivor.sessionId)
    const tableId = host.getSessionTabId(worker.identity.sessionId)
    expect(tableId).toBe(structuredAgentSessionTabId(worker.identity.sessionId))
    const release = Promise.withResolvers<void>()
    const close = worker.connection.close.bind(worker.connection)
    vi.spyOn(worker.connection, 'close').mockImplementation(async () => {
      await release.promise
      return close()
    })
    let answered = false
    const pending = cli(['orchestration', command, '--dispatch', worker.dispatchId]).then(
      (receipt) => {
        answered = true
        return receipt
      }
    )
    try {
      await vi.waitFor(() => expect(worker.connection.close).toHaveBeenCalled())
      expect(answered).toBe(false)
      expect(console.log).not.toHaveBeenCalled()
      expect(worker.connection.closed).toBe(false)
      expect(
        host.deps.store.getRecord(worker.identity.sessionId)?.lease.ownerProcess
      ).not.toBeNull()
      visible(worker.identity.sessionId, true)
      visible(survivor.sessionId, true)
      selectionPreserved()
      if (command === 'worker-stop') {
        expect(db.getWorkerDispatch(worker.dispatchId)?.state).toBe('stopping')
      } else {
        expect(db.getWorkerTerminalResourceByOwner(worker.dispatchId)).toMatchObject({
          release_state: 'releasing',
          archive_status: 'captured'
        })
      }
    } finally {
      release.resolve()
    }
    const receipt = await pending
    expect(receipt.code, receipt.stdout + receipt.stderr).toBe(0)
    expect(resultOf(receipt.output)).toMatchObject({
      dispatchId: worker.dispatchId,
      state: command === 'worker-stop' ? 'stopped' : 'released',
      processAction: 'closed_agent_terminal'
    })
    await chatTabCommandsSettled()
    await rig.profile.flushPendingOrThrowAsync()
    expect(worker.connection.closed).toBe(true)
    expect(host.deps.store.getRecord(worker.identity.sessionId)?.lease.ownerProcess).toBeNull()
    expect(host.hasSession(worker.identity.sessionId)).toBe(false)
    expect(host.getSessionTabId(worker.identity.sessionId)).toBeNull()
    visible(worker.identity.sessionId, false)
    visible(survivor.sessionId, true)
    selectionPreserved()
    if (command === 'worker-stop') {
      expect(db.getWorkerDispatch(worker.dispatchId)?.state).toBe('stopped')
      expect(db.getDispatchContextById(worker.dispatchId)?.status).toBe('failed')
    } else {
      expect(db.getWorkerTerminalResourceByOwner(worker.dispatchId)).toMatchObject({
        ownership_state: 'released',
        release_state: 'released',
        archive_status: 'captured'
      })
      const archived = await cli([
        'orchestration',
        'worker-read',
        '--dispatch',
        worker.dispatchId,
        '--source',
        'transcript'
      ])
      expect(archived.code, archived.stdout).toBe(0)
      expect(resultOf(archived.output)).toMatchObject({
        archived: true,
        status: { liveness: 'exited' }
      })
      expect(archived.stdout).toContain('READY from bounded provider')
    }
  }
)
