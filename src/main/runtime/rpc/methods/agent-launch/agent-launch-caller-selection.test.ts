/** Paired launches select only the caller's view; existing/folder targets select the tab, while worktree creates retain background provisioning. */

import { closeTestJournalHostDatabases } from '../../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openTestAgentSessionRecordStore } from '../../../agent-session/records/agent-session-record-store-test-harness'
import {
  CAPABLE_CLIENT,
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore
} from './agent-launch.test-fixture'

const createStructuredSession = vi.hoisted(() => vi.fn())
vi.mock('../structured-sessions/creation/structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: createStructuredSession
}))
const deliverTerminalPrompt = vi.hoisted(() => vi.fn(async () => true))
vi.mock('./agent-launch-terminal-prompt', () => ({
  deliverTerminalAgentLaunchPrompt: deliverTerminalPrompt
}))
const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH_REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')
const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')

const TAB_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const LEAF_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const EXISTING_LAUNCH = { agent: 'claude', target: { kind: 'existing', worktree: 'id:wt-7' } }

function selectionRuntime(options: Parameters<typeof runtimeStub>[0]) {
  return Object.assign(runtimeStub(options), {
    selectCreatedMobileSessionTabForClient: vi.fn(() => true)
  })
}

beforeEach(() => {
  deliverTerminalPrompt.mockClear()
  createStructuredSession
    .mockReset()
    .mockResolvedValue({ ok: true, value: { sessionId: 'sess-1' } })
})

describe('a replayed launch', () => {
  // The ledger admits against `Date.now()`, so the id must be dated now.
  const OPERATION_ID = `${Date.now()}-000000000000000000000000000000dd`
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-agent-launch-caller-'))
    const store = await openTestAgentSessionRecordStore(directory)
    setAgentLaunchRecordStore(store)
  })

  afterEach(async () => {
    setAgentLaunchRecordStore(null)
    await closeTestJournalHostDatabases()
    await rm(directory, { recursive: true, force: true })
  })

  it('answers from the record without moving the caller again', async () => {
    const params = AGENT_LAUNCH_REPLAY.params.parse({
      ...EXISTING_LAUNCH,
      operationId: OPERATION_ID
    })
    const first = selectionRuntime({ settings: {}, terminalPaneKey: PANE_KEY })
    await AGENT_LAUNCH_REPLAY.handler(params, rpcContext(first, CAPABLE_CLIENT))
    expect(first.selectCreatedMobileSessionTabForClient).toHaveBeenCalledOnce()

    const replay = selectionRuntime({ settings: {}, terminalPaneKey: PANE_KEY })
    await AGENT_LAUNCH_REPLAY.handler(params, rpcContext(replay, CAPABLE_CLIENT))

    expect(replay.createTerminal).not.toHaveBeenCalled()
    expect(replay.selectCreatedMobileSessionTabForClient).not.toHaveBeenCalled()
  })
})

describe('a focused chat launch from the local CLI', () => {
  it('asks the host window to select the chat', async () => {
    const runtime = Object.assign(runtimeStub({}), { focusLaunchedChatInHostWindow: vi.fn() })
    const params = AGENT_LAUNCH.params.parse({ ...EXISTING_LAUNCH, presentation: 'focused' })

    await AGENT_LAUNCH.handler(params, rpcContext(runtime, {}))

    expect(runtime.focusLaunchedChatInHostWindow).toHaveBeenCalledWith('wt-7', 'sess-1')
  })
})
