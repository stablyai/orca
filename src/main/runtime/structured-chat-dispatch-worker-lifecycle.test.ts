import './rpc/unused-default-rpc-methods.test-fixture'

import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { formatOrcaSessionAddress } from '../../shared/orca-session-address'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import { idOf } from './rpc/orchestration-session-caller-test-fixture'
import { closeStructuredAgentSessionChild } from './agent-session/structured-agent-session-close'
import { restoreJournal } from '../native-chat/agent-session-journal/journal-open'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { ORCHESTRATION_METHODS } from './rpc/methods/orchestration'
import type { FakeConnection } from './structured-chat-coordinator-fake-codex-fixture'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  call,
  clearChat,
  coordinatorRunAndTask,
  codex,
  db,
  dispatcher,
  host,
  openChat,
  request,
  root,
  runtime,
  sendUserMessage,
  settleTurn,
  startClearedContext
} from './structured-chat-coordinator-mail-rig.test-fixture'

const WORKER = formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))
const cliPath = join(process.cwd(), 'src/cli/index.ts')
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href

async function readWorkerThroughCli(dispatchId: string): Promise<string> {
  const env = { ...process.env }
  for (const name of [
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_RUNTIME_DIR',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'ORCA_E2E_HOME_DIR',
    'ORCA_E2E_USER_DATA_DIR',
    'ORCA_USER_DATA_PATH'
  ]) {
    env[name] = root
  }
  for (const name of [
    'ORCA_ENVIRONMENT',
    'ORCA_PAIRING_CODE',
    'ORCA_REMOTE_PAIRING',
    'ORCA_RUNTIME_SOURCE_ID',
    'ORCA_RUNTIME_SOURCE_INCARNATION',
    'ORCA_RUNTIME_SOURCE_PROFILE_PATH',
    'ORCA_TERMINAL_HANDLE',
    'ORCA_PANE_KEY',
    'ORCA_AGENT_LAUNCH_TOKEN',
    'ORCA_STRUCTURED_SESSION'
  ]) {
    env[name] = ''
  }
  env.ORCA_AGENT_SESSION_ID = COORDINATOR
  env.ORCA_BACKGROUND_LAUNCH = '1'
  env.ORCA_DISABLE_MACOS_LOGIN_SHELL = '1'
  // execFile owns its child handle, bounds its lifetime, and awaits exit before server cleanup.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      tsxLoader,
      '--conditions=orca-source',
      cliPath,
      'orchestration',
      'worker-read',
      '--dispatch',
      dispatchId,
      '--source',
      'transcript'
    ],
    { cwd: root, env, timeout: 15_000, windowsHide: true, encoding: 'utf8' }
  )
  return stdout
}

/** A Dispatch of the coordinator's task to the peer chat, both chats open. */
async function dispatchToChat(): Promise<{
  taskId: string
  dispatchId: string
  worker: FakeConnection
}> {
  await openChat(COORDINATOR)
  const worker = await openChat(PEER_CHAT)
  const { taskId } = await coordinatorRunAndTask()
  const { dispatch } = await call(
    'orchestration.dispatch',
    { task: taskId, to: WORKER },
    { sessionId: COORDINATOR }
  )
  return { taskId, dispatchId: idOf(dispatch), worker }
}

function workerDone(taskId: string, dispatchId: string) {
  return {
    subject: 'Done',
    type: 'worker_done',
    payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
  }
}

/** The chat is still open: its conversation attached and its tab listed. */
function expectChatOpen(sessionId: string): void {
  expect(host.hasSession(sessionId)).toBe(true)
  expect(host.deps.store.getVisibleSessionTabIndex().sessionIds).toContain(sessionId)
}

describe("a chat assignee's report", () => {
  it('is admitted from the chat itself, and settles its Dispatch', async () => {
    const { taskId, dispatchId } = await dispatchToChat()

    await call('orchestration.send', workerDone(taskId, dispatchId), { sessionId: PEER_CHAT })

    expect(db.getDispatchContextById(dispatchId)?.status).toBe('completed')
    expect(db.getTask(taskId)?.status).toBe('completed')
  })

  it('is admitted from the same cleared chat, which keeps its Dispatch', async () => {
    const { taskId, dispatchId } = await dispatchToChat()
    const cleared = await clearChat(PEER_CHAT)
    expect(cleared).toBe(PEER_CHAT)
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
    await startClearedContext(cleared)

    await call('orchestration.send', workerDone(taskId, dispatchId), { sessionId: cleared })

    expect(db.getDispatchContextById(dispatchId)?.status).toBe('completed')
  })

  it('is refused from a terminal that names the chat as its caller', async () => {
    const { taskId, dispatchId } = await dispatchToChat()

    const response = await dispatcher.dispatch(
      request('orchestration.send', { ...workerDone(taskId, dispatchId), from: WORKER })
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'session_caller_chat_not_declarable' }
    })
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
  })

  it("is refused from a terminal that carries the chat's Dispatch under its own handle", async () => {
    const { taskId, dispatchId } = await dispatchToChat()

    const receipt = await call('orchestration.send', {
      ...workerDone(taskId, dispatchId),
      from: 'term_worker'
    })

    expect(receipt).toMatchObject({ lifecycle: { action: 'rejected' } })
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
    expect(db.getTask(taskId)?.status).toBe('dispatched')
  })
})

describe("a chat assignee's liveness, stop and close", () => {
  it('reads live at rest, since the next send starts its agent', async () => {
    const { dispatchId } = await dispatchToChat()
    await host.close(PEER_CHAT, 'evict')
    expect(host.deps.store.getRecord(PEER_CHAT)?.lease.claimStatus).toBe('released')

    const shown = await call('orchestration.workerShow', { dispatch: dispatchId })

    expect(shown).toMatchObject({
      observation: { status: 'live', exactWorker: true },
      projection: { liveness: { verdict: 'live', source: 'execution_host' } }
    })
  })

  it('is stopped and abandoned without closing or interrupting the chat', async () => {
    const stopped = await dispatchToChat()
    expect(await call('orchestration.workerStop', { dispatch: stopped.dispatchId })).toMatchObject({
      processAction: 'none'
    })
    expectChatOpen(PEER_CHAT)

    const more = await call(
      'orchestration.taskCreate',
      { spec: 'more' },
      { sessionId: COORDINATOR }
    )
    const { dispatch } = await call(
      'orchestration.dispatch',
      { task: idOf(more.task), to: WORKER },
      { sessionId: COORDINATOR }
    )
    expect(await call('orchestration.workerAbandon', { dispatch: idOf(dispatch) })).toMatchObject({
      state: 'abandoned',
      processAction: 'none'
    })
    expectChatOpen(PEER_CHAT)
  })

  it('fails its Dispatch when the chat is closed, as a closed terminal does, and reads exited', async () => {
    const { taskId, dispatchId } = await dispatchToChat()

    // As the close RPC does when the person closes the chat's tab.
    await host.setSessionTabVisibility(PEER_CHAT, false)

    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'failed',
      termination_reason: 'operator_close'
    })
    expect(db.getTask(taskId)?.status).not.toBe('dispatched')
    expect(await call('orchestration.workerShow', { dispatch: dispatchId })).toMatchObject({
      observation: { status: 'exited' }
    })
  })

  it('keeps its Dispatch while a close puts the tab back, and fails it once a close is proven', async () => {
    const { dispatchId } = await dispatchToChat()
    vi.spyOn(host, 'close').mockRejectedValueOnce(new Error('the agent would not stop'))

    // As a refusable worktree removal closes each chat in it.
    const outcome = await closeStructuredAgentSessionChild(PEER_CHAT, {
      restoreTabOnUnprovenClose: true
    })

    expect(outcome).toMatchObject({ stopped: false, closeAttempted: true })
    expectChatOpen(PEER_CHAT)
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')

    expect(await closeStructuredAgentSessionChild(PEER_CHAT)).toMatchObject({ stopped: true })
    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'failed',
      termination_reason: 'operator_close'
    })
  })

  it("keeps its Dispatch when another chat's close lands while its own close is rolled back", async () => {
    const { dispatchId } = await dispatchToChat()
    let refuseClose: (error: Error) => void = () => undefined
    const close = vi
      .spyOn(host, 'close')
      .mockImplementationOnce(() => new Promise((_resolve, reject) => (refuseClose = reject)))
    const closing = closeStructuredAgentSessionChild(PEER_CHAT, { restoreTabOnUnprovenClose: true })
    await vi.waitFor(() => expect(close).toHaveBeenCalled(), WAIT)

    // Its tab is hidden pending the close when the other chat's notice re-derives.
    await host.setSessionTabVisibility(COORDINATOR, false)
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
    refuseClose(new Error('the agent would not stop'))

    expect(await closing).toMatchObject({ stopped: false, closeAttempted: true })
    expectChatOpen(PEER_CHAT)
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
  })

  it('reads unverifiable, never exited, when the cleared chat record is unknown', async () => {
    const { dispatchId } = await dispatchToChat()
    const cleared = await clearChat(PEER_CHAT)
    expect(cleared).toBe(PEER_CHAT)
    const getConversation = host.deps.store.getConversation.bind(host.deps.store)
    vi.spyOn(host.deps.store, 'getConversation').mockImplementation((sessionId) =>
      sessionId === cleared ? null : getConversation(sessionId)
    )

    expect(await call('orchestration.workerShow', { dispatch: dispatchId })).toMatchObject({
      observation: {
        status: 'unverifiable',
        reason: 'No durable record backs this chat.'
      },
      projection: { liveness: { verdict: 'unverifiable' } }
    })
    expect(await call('orchestration.workerList', {})).toMatchObject({
      workers: [{ dispatchId, projection: { liveness: { verdict: 'unverifiable' } } }]
    })
  })

  it("reads the chat's transcript for worker-read", async () => {
    const { dispatchId, worker } = await dispatchToChat()
    expect(await sendUserMessage(PEER_CHAT, 'working on it')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(worker.turns).toHaveLength(1), WAIT)
    await settleTurn(PEER_CHAT, 0)

    const journal = host.collaboratorsForTests().sessions.get(PEER_CHAT)?.journal
    if (!journal) {
      throw new Error('Worker conversation was not opened')
    }
    const prefix = journal.cursor()
    await host.close(PEER_CHAT, 'evict')
    expect(host.hasSession(PEER_CHAT)).toBe(false)
    const saved = restoreJournal(host.deps.journalDatabase.db, PEER_CHAT)?.state
    expect(saved?.lastSequence).toBeGreaterThanOrEqual(prefix.sequence)
    const acquisitions = codex.connections.length
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath: root,
      enableWebSocket: false,
      methods: ORCHESTRATION_METHODS
    })
    try {
      await server.start()
      const output = await readWorkerThroughCli(dispatchId)
      expect(output).toContain('Source: transcript (provider=codex)')
      expect(output).toContain('working on it')
      expect(host.hasSession(PEER_CHAT)).toBe(true)
      expect(codex.connections).toHaveLength(acquisitions)

      const read = await call('orchestration.workerRead', { dispatch: dispatchId })

      expect(read).toMatchObject({ source: 'transcript', status: { liveness: 'live' } })
      expect(JSON.stringify(read.transcript)).toContain('working on it')
    } finally {
      await server.stop()
    }
  })
})
