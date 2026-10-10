/**
 * A launch from a paired client moves that client's view to the new tab and nobody else's: the view
 * intent belongs to the connection that asked. In-process callers and worktree-creating launches
 * keep today's behaviour.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openTestAgentSessionRecordStore } from '../../agent-session-record-store-test-harness'
import type { RpcContext } from '../core'
import {
  CAPABLE_CLIENT,
  STRUCTURED_PREFERENCE,
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore,
  type AgentLaunchRuntimeStub
} from './agent-launch.test-fixture'

const createStructuredSession = vi.hoisted(() => vi.fn())
vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: createStructuredSession
}))
const deliverTerminalPrompt = vi.hoisted(() => vi.fn(async () => true))
vi.mock('./agent-launch-terminal-prompt', () => ({
  deliverTerminalAgentLaunchPrompt: deliverTerminalPrompt
}))
const commitChatPrompt = vi.hoisted(() => vi.fn(async () => 'message-1'))
vi.mock('./agent-launch-structured-prompt', () => ({
  commitStructuredAgentSessionLaunchPrompt: commitChatPrompt
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')
const AGENT_LAUNCH_REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')

const TAB_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const LEAF_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const EXISTING_LAUNCH = { agent: 'claude', target: { kind: 'existing', worktree: 'id:wt-7' } }
const CREATE_LAUNCH = {
  agent: 'claude',
  target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } }
}
const FOLDER_LAUNCH = {
  agent: 'claude',
  target: { kind: 'create-folder-workspace', create: { projectGroupId: 'group-1' } }
}
const CALLER = 'device-1'
const REVEAL_WARNING =
  'Terminal term_1 is running, but Orca could not make it discoverable. Run `orca terminal focus --terminal term_1` to reveal and focus it.'

function selectionRuntime(options: Parameters<typeof runtimeStub>[0]) {
  return Object.assign(runtimeStub(options), {
    selectCreatedMobileSessionTabForClient: vi.fn(() => true)
  })
}

async function launch(
  params: unknown,
  runtime: AgentLaunchRuntimeStub,
  context: Partial<RpcContext> = CAPABLE_CLIENT
) {
  return AGENT_LAUNCH.handler(AGENT_LAUNCH.params.parse(params), rpcContext(runtime, context))
}

function chatActivation(): unknown {
  return createStructuredSession.mock.calls[0]?.[0]?.activate
}

beforeEach(() => {
  deliverTerminalPrompt.mockClear()
  commitChatPrompt.mockClear()
  createStructuredSession
    .mockReset()
    .mockResolvedValue({ ok: true, value: { sessionId: 'sess-1' } })
})

describe('a paired client launching into an existing workspace', () => {
  it("selects the new terminal as that client's tab only", async () => {
    const runtime = selectionRuntime({ settings: {}, terminalPaneKey: PANE_KEY })

    await launch(EXISTING_LAUNCH, runtime)

    expect(runtime.selectCreatedMobileSessionTabForClient).toHaveBeenCalledExactlyOnceWith(
      'wt-7',
      expect.objectContaining({ tabId: TAB_ID, leafId: LEAF_ID }),
      CALLER
    )
  })

  it('publishes the chat without activating it for everyone, then selects it by session for the caller', async () => {
    const runtime = selectionRuntime({ settings: STRUCTURED_PREFERENCE })

    const result = await launch(EXISTING_LAUNCH, runtime)

    expect(result.outcome.kind).toBe('structured')
    expect(chatActivation()).toBe(false)
    expect(runtime.selectCreatedMobileSessionTabForClient).toHaveBeenCalledExactlyOnceWith(
      'wt-7',
      { sessionId: 'sess-1' },
      CALLER
    )
  })

  // Why: a pasted prompt waits up to a minute for the agent; the caller's view must not wait with it.
  it.each([
    ['terminal', {}, deliverTerminalPrompt],
    ['chat', STRUCTURED_PREFERENCE, commitChatPrompt]
  ] as const)(
    'selects the new %s for the caller before its prompt is delivered',
    async (_surface, settings, deliver) => {
      const runtime = selectionRuntime({ settings, terminalPaneKey: PANE_KEY })

      await launch(
        { ...EXISTING_LAUNCH, prompt: { text: 'Fix it.\nLog:', delivery: 'submit' } },
        runtime
      )

      const selectedAt = runtime.selectCreatedMobileSessionTabForClient.mock.invocationCallOrder[0]
      const deliveredAt = deliver.mock.invocationCallOrder[0]
      expect(deliveredAt).toBeDefined()
      expect(selectedAt).toBeLessThan(deliveredAt!)
    }
  )

  it('still reports the launch when selecting its tab fails', async () => {
    const runtime = selectionRuntime({ settings: {}, terminalPaneKey: PANE_KEY })
    runtime.selectCreatedMobileSessionTabForClient.mockImplementationOnce(() => {
      throw new Error('selection store unavailable')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await launch(EXISTING_LAUNCH, runtime)

    expect(result.outcome).toMatchObject({ kind: 'terminal', handle: 'term_1' })
    warn.mockRestore()
  })

  // Why: a headless `--serve` host has no window to reveal into; the caller mirrors the tab anyway.
  it('does not pass on the host’s own reveal warning, since the caller shows the tab itself', async () => {
    const runtime = selectionRuntime({
      settings: {},
      terminalPaneKey: PANE_KEY,
      terminalWarning: REVEAL_WARNING
    })

    const result = await launch(EXISTING_LAUNCH, runtime)

    expect(result.outcome).toMatchObject({ kind: 'terminal', handle: 'term_1' })
    expect(result.warning).toBeUndefined()
  })

  // A folder workspace has no setup for a host activation to run, so its create moves only the caller.
  it('selects the chat in a folder workspace it creates without activating it on the host', async () => {
    const runtime = selectionRuntime({ settings: STRUCTURED_PREFERENCE })

    // A desktop client of a remote server; a phone may not create folder workspaces at all.
    await launch(FOLDER_LAUNCH, runtime, { ...CAPABLE_CLIENT, clientKind: 'runtime' })

    expect(chatActivation()).toBe(false)
    expect(runtime.selectCreatedMobileSessionTabForClient).toHaveBeenCalledExactlyOnceWith(
      'folder:fw-new',
      { sessionId: 'sess-1' },
      CALLER
    )
  })

  it('selects nothing when the runtime reported no pane for the terminal', async () => {
    const runtime = selectionRuntime({ settings: {} })

    await launch(EXISTING_LAUNCH, runtime)

    expect(runtime.selectCreatedMobileSessionTabForClient).not.toHaveBeenCalled()
  })
})

describe('launches that keep the host-wide behaviour', () => {
  it('an in-process caller activates the chat and selects nothing per client', async () => {
    const runtime = selectionRuntime({ settings: STRUCTURED_PREFERENCE })

    await launch(EXISTING_LAUNCH, runtime, {})

    expect(chatActivation()).toBe(true)
    expect(runtime.selectCreatedMobileSessionTabForClient).not.toHaveBeenCalled()
  })

  it('an in-process caller still hears that the host could not reveal the tab', async () => {
    const runtime = selectionRuntime({ settings: {}, terminalWarning: REVEAL_WARNING })

    const result = await launch(EXISTING_LAUNCH, runtime, {})

    expect(result.warning).toBe(REVEAL_WARNING)
  })

  it("the host's own desktop window, a runtime client with no paired device, still activates the chat", async () => {
    const runtime = selectionRuntime({ settings: STRUCTURED_PREFERENCE })

    await launch(EXISTING_LAUNCH, runtime, {
      ...CAPABLE_CLIENT,
      clientKind: 'runtime',
      pairedDeviceId: undefined
    })

    expect(chatActivation()).toBe(true)
    expect(runtime.selectCreatedMobileSessionTabForClient).not.toHaveBeenCalled()
  })

  it('a worktree-creating launch from a paired client keeps the create navigation', async () => {
    const runtime = selectionRuntime({ settings: STRUCTURED_PREFERENCE })

    await launch(CREATE_LAUNCH, runtime)

    expect(chatActivation()).toBe(true)
    expect(runtime.selectCreatedMobileSessionTabForClient).not.toHaveBeenCalled()
  })
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
