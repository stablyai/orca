/**
 * The tab of an `agent.launch` appears before the launch is admitted, at the requested place, and
 * the spawn lands in that tab's pane. Driven through the method's handler with the shared runtime
 * stub and the real durable ledger, so "before admission" is read off the order the host asked for
 * the tab and opened the launch record.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_TAB_CLOSED_CLIENT_CAPABILITY,
  AGENT_LAUNCH_UNSTARTED_TAB_CLIENT_CAPABILITY
} from '../../../../shared/agent-launch-runtime-capability'
import { AGENT_LAUNCH_TAB_CLOSED_CODE } from '../../../../shared/agent-launch-tab-closed'
import { classifyAgentLaunchReplayRefusal } from '../../../../shared/agent-launch-replay-refusal'
import { mapRuntimeError } from '../errors'
import type { AgentLaunchResult } from '../../../../shared/agent-launch-intent'
import type {
  AgentLaunchTabPublished,
  AgentLaunchTabPublishRequest
} from '../../../../shared/agent-launch-tab-publication'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  markAgentLaunchesClosedByUser,
  resetAgentLaunchPanesForTests,
  resolveAgentLaunchPaneVerdict,
  type AgentLaunchPaneEvidence
} from '../../../agent-launch/agent-launch-pane-attachment'
import type { AgentLaunchPaneVerdict } from '../../../../shared/agent-launch-pane-verdict'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../agent-session-record-store-test-harness'
import type { RpcContext } from '../core'
import { DESKTOP_RPC_CALLER } from '../rpc-caller-identity'
import {
  STRUCTURED_PREFERENCE,
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore,
  type AgentLaunchRuntimeStubOptions
} from './agent-launch.test-fixture'

const deliverTerminalAgentLaunchPrompt = vi.hoisted(() => vi.fn(async () => true))
vi.mock('./agent-launch-terminal-prompt', () => ({ deliverTerminalAgentLaunchPrompt }))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')
const AGENT_LAUNCH_REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')

const TAB_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const LEAF_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const TERMINAL_ONLY = {}
const LAUNCH = { agent: 'claude', target: { kind: 'existing', worktree: 'id:wt-7' } }
const CLI: Partial<RpcContext> = {}
const DESKTOP: Partial<RpcContext> = {
  caller: DESKTOP_RPC_CALLER,
  clientKind: 'runtime',
  clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
}
const OLD_PHONE: Partial<RpcContext> = {
  clientKind: 'mobile',
  pairedDeviceId: 'device-1',
  clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
}
const PHONE: Partial<RpcContext> = {
  ...OLD_PHONE,
  clientCapabilities: [
    AGENT_LAUNCH_RUNTIME_CAPABILITY,
    AGENT_LAUNCH_UNSTARTED_TAB_CLIENT_CAPABILITY
  ]
}

const PAIRED_DESKTOP: Partial<RpcContext> = {
  clientKind: 'runtime',
  pairedDeviceId: 'device-2',
  clientCapabilities: [
    AGENT_LAUNCH_RUNTIME_CAPABILITY,
    AGENT_LAUNCH_UNSTARTED_TAB_CLIENT_CAPABILITY
  ]
}

const PHONE_READING_TAB_CLOSED: Partial<RpcContext> = {
  ...OLD_PHONE,
  clientCapabilities: [
    AGENT_LAUNCH_RUNTIME_CAPABILITY,
    AGENT_LAUNCH_UNSTARTED_TAB_CLIENT_CAPABILITY,
    AGENT_LAUNCH_TAB_CLOSED_CLIENT_CAPABILITY
  ]
}

let directory: string
let store: AgentSessionRecordStore
let operationCounter = 0

function nextOperationId(): string {
  operationCounter += 1
  return `${Date.now()}-${operationCounter.toString(16).padStart(32, '0')}`
}

beforeEach(async () => {
  deliverTerminalAgentLaunchPrompt.mockClear()
  directory = await mkdtemp(join(tmpdir(), 'agent-launch-instant-tab-'))
  store = await openTestAgentSessionRecordStore(directory)
  setAgentLaunchRecordStore(store)
})

afterEach(async () => {
  setAgentLaunchRecordStore(null)
  resetAgentLaunchPanesForTests()
  await rm(directory, { recursive: true, force: true })
})

/** A host with a window that shows the tab, recording what it was asked and in what order. */
function hostWithWindow(
  options: AgentLaunchRuntimeStubOptions & {
    reply?: Partial<AgentLaunchTabPublished> | Error
  } = {}
) {
  const events: string[] = []
  const published: Omit<AgentLaunchTabPublishRequest, 'requestId'>[] = []
  const runtime = runtimeStub({
    settings: TERMINAL_ONLY,
    ...options,
    publishAgentLaunchTab: (request) => {
      events.push('tab')
      published.push(request)
      return options.reply instanceof Error
        ? Promise.reject(options.reply)
        : Promise.resolve({
            tabId: request.tabId,
            created: true,
            placement: { groupId: 'group-1' },
            ...options.reply
          })
    }
  })
  const openStore = runtime.openAgentSessionRecordStore.getMockImplementation()!
  runtime.openAgentSessionRecordStore.mockImplementation(async () => {
    events.push('admission')
    return openStore()
  })
  const createTerminal = runtime.createTerminal.getMockImplementation()!
  runtime.createTerminal.mockImplementation(async (selector, createOptions) => {
    events.push('spawn')
    return createTerminal(selector, createOptions)
  })
  return Object.assign(runtime, {
    events,
    published,
    selectCreatedMobileSessionTabForClient: vi.fn(() => true)
  })
}

type Host = ReturnType<typeof hostWithWindow>

function replayLaunch(
  runtime: Host,
  params: Record<string, unknown>,
  context: Partial<RpcContext>
): Promise<AgentLaunchResult> {
  return AGENT_LAUNCH_REPLAY.handler(
    AGENT_LAUNCH_REPLAY.params.parse({ ...LAUNCH, operationId: nextOperationId(), ...params }),
    rpcContext(runtime, context)
  )
}

function plainLaunch(
  runtime: Host,
  params: Record<string, unknown>,
  context: Partial<RpcContext>
): Promise<AgentLaunchResult> {
  return AGENT_LAUNCH.handler(
    AGENT_LAUNCH.params.parse({ ...LAUNCH, ...params }),
    rpcContext(runtime, context)
  )
}

function terminalOptions(runtime: Host): Record<string, unknown> {
  return runtime.createTerminal.mock.calls[0]?.[1] ?? {}
}

/** What the pane reads when it mounts: this host's runtime, and the launch record on disk. */
function paneEvidence(
  runtime: Host,
  record: AgentSessionRecordStore = store
): AgentLaunchPaneEvidence {
  return {
    isPaneLive: (paneKey) => runtime.hasLiveTerminalForPaneKey(paneKey),
    openedRows: () => record.listOperationRows(),
    launchPaneOnTab: () => ({}),
    openRows: async () => record.listOperationRows(),
    now: () => Date.now()
  }
}

async function paneVerdict(
  runtime: Host,
  record?: AgentSessionRecordStore,
  paneKey = PANE_KEY
): Promise<AgentLaunchPaneVerdict | 'unowned'> {
  return (
    (await resolveAgentLaunchPaneVerdict(
      { worktreeId: 'wt-7', paneKey },
      paneEvidence(runtime, record)
    )) ?? 'unowned'
  )
}

/** The record not open yet when the request arrives, as on the first launch after a restart. */
function coldRecord(runtime: Host): Host {
  // Only at the publish: admission opens it.
  runtime.openedAgentSessionRecordStore.mockReturnValueOnce(null)
  return runtime
}

/** A spawn that fails before the daemon was asked for a process: nothing can be running. */
function failBeforeDispatch(runtime: Host, message: string): void {
  runtime.createTerminal.mockRejectedValueOnce(new Error(message))
}

/** A spawn the daemon was asked for, whose answer was lost: the process may exist. */
function failAfterDispatch(runtime: Host, message: string): void {
  runtime.createTerminal.mockImplementationOnce(async (_selector, createOptions) => {
    const dispatched = createOptions?.onPtySpawnDispatched
    if (typeof dispatched === 'function') {
      dispatched()
    }
    throw new Error(message)
  })
}

describe('the instant tab', () => {
  it('is asked for before the launch is admitted, and the spawn lands in its pane', async () => {
    const runtime = hostWithWindow({ terminalPaneKey: PANE_KEY })

    await replayLaunch(runtime, { paneKey: PANE_KEY }, CLI)

    expect(runtime.events.indexOf('tab')).toBeLessThan(runtime.events.indexOf('admission'))
    expect(runtime.published[0]).toMatchObject({
      worktreeId: 'wt-7',
      tabId: TAB_ID,
      leafId: LEAF_ID
    })
    expect(terminalOptions(runtime)).toMatchObject({ tabId: TAB_ID, leafId: LEAF_ID })
  })

  it('names a pane the host minted when the caller sent none, and spawns into that pane', async () => {
    const runtime = hostWithWindow()

    await replayLaunch(runtime, {}, CLI)

    const request = runtime.published[0]!
    expect(terminalOptions(runtime)).toMatchObject({
      tabId: request.tabId,
      leafId: request.leafId,
      requireFreshPane: true
    })
  })

  it('binds the spawn to the shown tab without moving anyone a second time', async () => {
    const runtime = hostWithWindow()

    await replayLaunch(runtime, { presentation: 'focused' }, CLI)

    expect(terminalOptions(runtime)).toMatchObject({ surfaceOwner: false })
  })

  it('reveals the spawn as before when the window never said it showed the tab', async () => {
    const runtime = hostWithWindow({ reply: new Error('renderer_unavailable') })

    const result = await replayLaunch(runtime, {}, CLI)

    expect(result.outcome.kind).toBe('terminal')
    expect(result.placement).toBeUndefined()
    expect(terminalOptions(runtime)).not.toHaveProperty('surfaceOwner')
  })

  it('records the pane it showed with the launch, and lets the pane attach once the agent runs', async () => {
    const runtime = hostWithWindow({ terminalPaneKey: PANE_KEY })

    await replayLaunch(runtime, { paneKey: PANE_KEY }, CLI)

    expect(store.listOperationRows()[0]?.ownedPane).toEqual({
      worktreeId: 'wt-7',
      paneKey: PANE_KEY
    })
    await expect(paneVerdict(runtime)).resolves.toEqual({ kind: 'proceed' })
    expect(runtime.reportAgentLaunchPaneVerdict).not.toHaveBeenCalled()
  })

  it('is not shown early for a chat-mode launch, whose tab is the session', async () => {
    const runtime = hostWithWindow({ settings: STRUCTURED_PREFERENCE })

    await replayLaunch(runtime, {}, CLI)

    expect(runtime.published).toEqual([])
  })

  it('is not shown early to a phone that would read a listed tab as a started agent', async () => {
    const runtime = hostWithWindow()

    await replayLaunch(runtime, { paneKey: PANE_KEY }, OLD_PHONE)

    expect(runtime.published).toEqual([])
  })

  it('is not shown early without an operation id: no record could tell its pane how it ended', async () => {
    const runtime = hostWithWindow()

    await plainLaunch(runtime, {}, CLI)

    expect(runtime.published).toEqual([])
  })
})

describe('the pane while its launch delivers the prompt', () => {
  function launchDeliveringSlowly(runtime: Host): {
    launched: Promise<AgentLaunchResult>
    deliver: (delivered: boolean) => void
  } {
    let deliver!: (delivered: boolean) => void
    deliverTerminalAgentLaunchPrompt.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (deliver = resolve))
    )
    const launched = replayLaunch(
      runtime,
      { paneKey: PANE_KEY, prompt: { text: 'fix the build', delivery: 'submit' } },
      CLI
    )
    return { launched, deliver: (delivered) => deliver(delivered) }
  }

  it('attaches to the agent as soon as it exists, not when the prompt is delivered', async () => {
    const runtime = hostWithWindow({ terminalPaneKey: PANE_KEY, lineCarriesPrompt: false })
    const { launched, deliver } = launchDeliveringSlowly(runtime)
    await vi.waitFor(() => expect(deliverTerminalAgentLaunchPrompt).toHaveBeenCalled())

    const verdict = await Promise.race([
      paneVerdict(runtime),
      new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), 200))
    ])
    expect(verdict).toEqual({ kind: 'proceed' })

    deliver(true)
    await expect(launched).resolves.toMatchObject({ outcome: { kind: 'terminal' } })
    // The pane's own spawn settles its tab; the launch reports nothing for a pane it ran in.
    expect(runtime.reportAgentLaunchPaneVerdict).not.toHaveBeenCalled()
  })

  it('still stops the launch as closed when its attached tab is closed before the prompt lands', async () => {
    const runtime = hostWithWindow({ terminalPaneKey: PANE_KEY, lineCarriesPrompt: false })
    const { launched, deliver } = launchDeliveringSlowly(runtime)
    await vi.waitFor(() => expect(deliverTerminalAgentLaunchPrompt).toHaveBeenCalled())
    await expect(paneVerdict(runtime)).resolves.toEqual({ kind: 'proceed' })

    // Main's commit of the user's tab close, as the window sends it.
    markAgentLaunchesClosedByUser('wt-7', { kind: 'tab', tabId: TAB_ID })
    deliver(true)

    await expect(launched).rejects.toMatchObject({ code: AGENT_LAUNCH_TAB_CLOSED_CODE })
    expect(runtime.closeTerminal).toHaveBeenCalledWith('term_1')
  })
})

describe('the pane after its launch', () => {
  it('says a failed spawn did not start, keeps the tab, and says it again after a restart', async () => {
    const runtime = hostWithWindow()
    failBeforeDispatch(runtime, 'spawn claude ENOENT')

    await expect(replayLaunch(runtime, { paneKey: PANE_KEY }, CLI)).rejects.toThrow('ENOENT')

    await expect(paneVerdict(runtime)).resolves.toEqual({
      kind: 'not-started',
      code: 'spawn claude ENOENT'
    })
    // Kept, and told: the tab records the outcome even if its pane never mounts.
    expect(runtime.reportAgentLaunchPaneVerdict).not.toHaveBeenCalledWith(expect.anything(), {
      kind: 'withdrawn'
    })
    await vi.waitFor(() =>
      expect(runtime.reportAgentLaunchPaneVerdict).toHaveBeenCalledWith(
        { worktreeId: 'wt-7', tabId: TAB_ID, leafId: LEAF_ID },
        { kind: 'not-started', code: 'spawn claude ENOENT' }
      )
    )
    // A restarted host: no launch in memory, the record read back from disk.
    resetAgentLaunchPanesForTests()
    const reopened = await openTestAgentSessionRecordStore(directory)
    await expect(paneVerdict(hostWithWindow(), reopened)).resolves.toMatchObject({
      kind: 'not-started'
    })
  })

  it('says it cannot confirm a spawn whose outcome is unknown, and attaches if the agent turns up', async () => {
    const runtime = hostWithWindow()
    failAfterDispatch(runtime, 'daemon create timed out')

    await expect(replayLaunch(runtime, { paneKey: PANE_KEY }, CLI)).rejects.toThrow(
      'agent_session_operation_unknown'
    )

    await expect(paneVerdict(runtime)).resolves.toEqual({ kind: 'unconfirmed' })
    runtime.hasLiveTerminalForPaneKey.mockReturnValue(true)
    await expect(paneVerdict(runtime)).resolves.toEqual({ kind: 'proceed' })
  })

  it("never touches a running agent's pane when a second launch names it", async () => {
    const first = hostWithWindow({ terminalPaneKey: PANE_KEY })
    await replayLaunch(first, { paneKey: PANE_KEY }, CLI)

    const second = hostWithWindow({
      adoptedPanes: { [PANE_KEY]: 'term_1' },
      terminalPaneAlreadyLive: true
    })
    await expect(replayLaunch(second, { paneKey: PANE_KEY }, CLI)).rejects.toThrow(
      'agent_launch_pane_already_live'
    )

    expect(second.published).toEqual([])
    expect(second.reportAgentLaunchPaneVerdict).not.toHaveBeenCalled()
    // Its agent exits and the pane remounts: still the first launch's pane, never "couldn't start".
    second.hasLiveTerminalForPaneKey.mockReturnValue(false)
    await expect(paneVerdict(second)).resolves.toEqual({ kind: 'proceed' })
  })

  it('takes back a tab nothing ran into without letting its waiting pane start a shell', async () => {
    const operationId = nextOperationId()
    await replayLaunch(hostWithWindow({ terminalPaneKey: PANE_KEY }), { operationId }, CLI)

    const verdicts: Promise<AgentLaunchPaneVerdict | 'unowned'>[] = []
    const refused = coldRecord(hostWithWindow())
    const publish = refused.publishAgentLaunchTab.getMockImplementation()!
    refused.publishAgentLaunchTab.mockImplementation((request) => {
      const published = publish(request)
      // The pane mounts as soon as the tab exists.
      verdicts.push(paneVerdict(refused, store, `${request.tabId}:${request.leafId}`))
      return published
    })
    // The same id with other params: a conflict, so admission refuses and nothing runs.
    await expect(
      replayLaunch(
        refused,
        { operationId, paneKey: PANE_KEY, prompt: { text: 'other', delivery: 'submit' } },
        CLI
      )
    ).rejects.toThrow('agent_session_operation_conflict')

    await expect(verdicts[0]).resolves.toEqual({ kind: 'withdrawn' })
    await vi.waitFor(() =>
      expect(refused.reportAgentLaunchPaneVerdict).toHaveBeenCalledWith(
        expect.objectContaining({ worktreeId: 'wt-7' }),
        { kind: 'withdrawn' }
      )
    )
  })

  it('ends every shown pane nothing spawned into in a verdict, never a blank pane', async () => {
    // A tab the window already had (created: false) whose launch failed before its spawn.
    const runtime = hostWithWindow({ reply: { created: false } })
    failBeforeDispatch(runtime, 'spawn claude ENOENT')

    await expect(replayLaunch(runtime, { paneKey: PANE_KEY }, CLI)).rejects.toThrow('ENOENT')

    await vi.waitFor(() =>
      expect(runtime.reportAgentLaunchPaneVerdict).toHaveBeenCalledWith(
        { worktreeId: 'wt-7', tabId: TAB_ID, leafId: LEAF_ID },
        { kind: 'not-started', code: 'spawn claude ENOENT' }
      )
    )
  })
})

describe('retries', () => {
  it('a retry of a recorded launch shows no tab: no flash, no reset, no one moved', async () => {
    const operationId = nextOperationId()
    await replayLaunch(
      hostWithWindow({ terminalPaneKey: PANE_KEY }),
      { operationId, paneKey: PANE_KEY },
      CLI
    )

    for (const replayed of [
      hostWithWindow({ adoptedPanes: { [PANE_KEY]: 'term_1' } }),
      hostWithWindow({ reply: { created: false } }),
      hostWithWindow()
    ]) {
      await replayLaunch(replayed, { paneKey: PANE_KEY, operationId }, CLI)
      expect(replayed.published).toEqual([])
      expect(replayed.reportAgentLaunchPaneVerdict).not.toHaveBeenCalled()
      expect(replayed.createTerminal).not.toHaveBeenCalled()
    }
  })

  it('a refusal that brings a fresh pane flashes nothing when the record already holds its id', async () => {
    const operationId = nextOperationId()
    await replayLaunch(hostWithWindow({ terminalPaneKey: PANE_KEY }), { operationId }, CLI)

    const refused = hostWithWindow()
    await expect(
      replayLaunch(
        refused,
        { operationId, paneKey: PANE_KEY, prompt: { text: 'other', delivery: 'submit' } },
        CLI
      )
    ).rejects.toThrow('agent_session_operation_conflict')
    expect(refused.published).toEqual([])
  })

  it('with the record not yet open: a tab still shown keeps what its launch came to', async () => {
    const operationId = nextOperationId()
    const first = hostWithWindow()
    failAfterDispatch(first, 'daemon create timed out')
    await expect(replayLaunch(first, { paneKey: PANE_KEY, operationId }, CLI)).rejects.toThrow(
      'agent_session_operation_unknown'
    )

    // After a restart: the retry publishes onto the restored tab, which the window keeps as is.
    const retried = coldRecord(hostWithWindow({ reply: { created: false } }))
    await expect(replayLaunch(retried, { paneKey: PANE_KEY, operationId }, CLI)).rejects.toThrow(
      'agent_session_operation_unknown'
    )
    expect(retried.published[0]?.operationId).toBe(operationId)
    await vi.waitFor(() =>
      expect(retried.reportAgentLaunchPaneVerdict).toHaveBeenCalledWith(
        { worktreeId: 'wt-7', tabId: TAB_ID, leafId: LEAF_ID },
        { kind: 'unconfirmed' }
      )
    )
  })

  it('with the record not yet open: a tab remade for nothing goes, one an agent survived in stays', async () => {
    const operationId = nextOperationId()
    await replayLaunch(
      hostWithWindow({ terminalPaneKey: PANE_KEY }),
      { paneKey: PANE_KEY, operationId },
      CLI
    )

    const remadeForNothing = coldRecord(hostWithWindow())
    await replayLaunch(remadeForNothing, { paneKey: PANE_KEY, operationId }, CLI)
    await vi.waitFor(() =>
      expect(remadeForNothing.reportAgentLaunchPaneVerdict).toHaveBeenCalledWith(
        { worktreeId: 'wt-7', tabId: TAB_ID, leafId: LEAF_ID },
        { kind: 'withdrawn' }
      )
    )

    const survived = coldRecord(hostWithWindow())
    // The agent's pane comes back while the replay runs (the daemon kept it across a crash).
    survived.publishAgentLaunchTab.mockImplementationOnce(async (request) => {
      survived.hasLiveTerminalForPaneKey.mockReturnValue(true)
      return { tabId: request.tabId, created: true, placement: { groupId: 'group-1' } }
    })
    await replayLaunch(survived, { paneKey: PANE_KEY, operationId }, CLI)
    await vi.waitFor(() =>
      expect(survived.reportAgentLaunchPaneVerdict).toHaveBeenCalledWith(
        { worktreeId: 'wt-7', tabId: TAB_ID, leafId: LEAF_ID },
        { kind: 'proceed' }
      )
    )
    expect(survived.reportAgentLaunchPaneVerdict).not.toHaveBeenCalledWith(expect.anything(), {
      kind: 'withdrawn'
    })
  })
})

describe('the user closing the tab while it starts', () => {
  function closeTabWhenShown(runtime: Host): void {
    const publish = runtime.publishAgentLaunchTab.getMockImplementation()!
    runtime.publishAgentLaunchTab.mockImplementation((request) => {
      const published = publish(request)
      markAgentLaunchesClosedByUser('wt-7', { kind: 'tab', tabId: request.tabId })
      return published
    })
  }

  it('stops the launch before its agent spawns, and that is its answer, now and on every retry', async () => {
    const operationId = nextOperationId()
    const runtime = hostWithWindow({ terminalPaneKey: PANE_KEY })
    closeTabWhenShown(runtime)

    await expect(
      replayLaunch(runtime, { paneKey: PANE_KEY, operationId }, CLI)
    ).rejects.toMatchObject({
      code: AGENT_LAUNCH_TAB_CLOSED_CODE
    })
    expect(runtime.createTerminal).not.toHaveBeenCalled()
    expect(store.listOperationRows()[0]?.outcome).toEqual({
      status: 'failed',
      code: AGENT_LAUNCH_TAB_CLOSED_CODE
    })

    const retried = hostWithWindow()
    await expect(replayLaunch(retried, { paneKey: PANE_KEY, operationId }, CLI)).rejects.toThrow(
      AGENT_LAUNCH_TAB_CLOSED_CODE
    )
    expect(retried.published).toEqual([])
  })

  it('stops an agent whose tab was closed while its terminal was created, before its prompt is pasted', async () => {
    const runtime = hostWithWindow({ terminalPaneKey: PANE_KEY, lineCarriesPrompt: false })
    const spawn = runtime.createTerminal.getMockImplementation()!
    runtime.createTerminal.mockImplementationOnce(async (selector, createOptions) => {
      markAgentLaunchesClosedByUser('wt-7', { kind: 'tab', tabId: TAB_ID })
      return spawn(selector, createOptions)
    })

    await expect(
      replayLaunch(
        runtime,
        { paneKey: PANE_KEY, prompt: { text: 'fix the build', delivery: 'submit' } },
        CLI
      )
    ).rejects.toMatchObject({ code: AGENT_LAUNCH_TAB_CLOSED_CODE })
    expect(runtime.closeTerminal).toHaveBeenCalledWith('term_1')
    expect(deliverTerminalAgentLaunchPrompt).not.toHaveBeenCalled()
  })

  it('stops an agent that already spawned', async () => {
    const runtime = hostWithWindow({ terminalPaneKey: PANE_KEY })
    const spawn = runtime.createTerminal.getMockImplementation()!
    runtime.createTerminal.mockImplementationOnce(async (selector, createOptions) => {
      const created = await spawn(selector, createOptions)
      markAgentLaunchesClosedByUser('wt-7', { kind: 'tab', tabId: TAB_ID })
      return created
    })

    await expect(replayLaunch(runtime, { paneKey: PANE_KEY }, CLI)).rejects.toMatchObject({
      code: AGENT_LAUNCH_TAB_CLOSED_CODE
    })
    expect(runtime.closeTerminal).toHaveBeenCalledWith('term_1')
  })

  it('reaches a caller that reads the word as its own code on the wire, which the phone reads as failed', async () => {
    const runtime = hostWithWindow({ terminalPaneKey: PANE_KEY })
    closeTabWhenShown(runtime)

    const thrown: unknown = await replayLaunch(
      runtime,
      { paneKey: PANE_KEY },
      PHONE_READING_TAB_CLOSED
    ).catch((error: unknown) => error)
    const failure = mapRuntimeError('req-1', { runtimeId: 'runtime-1' }, thrown)

    expect(failure.error).toMatchObject({ code: AGENT_LAUNCH_TAB_CLOSED_CODE })
    // What the phone's launch switches on: a definite failure, worded by its own copy for this code.
    expect(classifyAgentLaunchReplayRefusal(failure.error, false)).toBe('failed')
  })

  it('tells a caller that cannot read the word what it always heard', async () => {
    const operationId = nextOperationId()
    const runtime = hostWithWindow({ terminalPaneKey: PANE_KEY })
    closeTabWhenShown(runtime)

    await expect(replayLaunch(runtime, { paneKey: PANE_KEY, operationId }, PHONE)).rejects.toThrow(
      'agent_session_operation_unknown'
    )
    await expect(
      replayLaunch(hostWithWindow(), { paneKey: PANE_KEY, operationId }, PHONE)
    ).rejects.toThrow('agent_session_operation_unknown')
    await expect(
      replayLaunch(hostWithWindow(), { paneKey: PANE_KEY, operationId }, PHONE_READING_TAB_CLOSED)
    ).rejects.toThrow(AGENT_LAUNCH_TAB_CLOSED_CODE)
  })
})

describe('placement', () => {
  it('passes the requested place to the window and reports where the tab landed', async () => {
    const runtime = hostWithWindow({
      reply: { placement: { groupId: 'group-anchor', fallback: 'anchor-group' } }
    })

    const result = await replayLaunch(
      runtime,
      { placement: { groupId: 'group-closed', afterTabId: 'tab-anchor' } },
      CLI
    )

    expect(runtime.published[0]?.placement).toEqual({
      groupId: 'group-closed',
      afterTabId: 'tab-anchor'
    })
    expect(result.placement).toEqual({ groupId: 'group-anchor', fallback: 'anchor-group' })
  })

  it("hands a CLI's focused launch to the window with its group, to land there as the window is moved", async () => {
    const runtime = hostWithWindow()

    await replayLaunch(
      runtime,
      { placement: { groupId: 'group-split' }, presentation: 'focused' },
      CLI
    )

    expect(runtime.published[0]).toMatchObject({
      placement: { groupId: 'group-split' },
      viewer: 'focus-window'
    })
  })

  it('is not part of what a retry must repeat', async () => {
    const operationId = nextOperationId()
    const runtime = hostWithWindow({ terminalPaneKey: PANE_KEY })
    await replayLaunch(
      runtime,
      { paneKey: PANE_KEY, operationId, placement: { groupId: 'g-1' } },
      CLI
    )

    await expect(
      replayLaunch(
        hostWithWindow({ reply: { created: false } }),
        { paneKey: PANE_KEY, operationId, placement: { groupId: 'g-2' } },
        CLI
      )
    ).resolves.toMatchObject({ outcome: { kind: 'terminal' } })
  })
})

describe('whose view moves', () => {
  it.each([
    ['a local caller asking for focus moves the window', CLI, 'focused', 'focus-window'],
    ['a local caller by default reveals the workspace as before', CLI, undefined, 'reveal-owner'],
    [
      'the desktop stays in its workspace if you moved on',
      DESKTOP,
      undefined,
      'focus-in-workspace'
    ],
    ['a phone asking for focus leaves the desktop where it is', PHONE, 'focused', 'none'],
    ['a phone by default leaves it too', PHONE, undefined, 'none'],
    ['a paired desktop leaves the host window too', PAIRED_DESKTOP, 'focused', 'none'],
    ['background moves nobody', CLI, 'background', 'none']
  ] as const)('%s', async (_name, context, presentation, viewer) => {
    const runtime = hostWithWindow()

    await replayLaunch(runtime, presentation ? { presentation } : {}, context)

    expect(runtime.published[0]?.viewer).toBe(viewer)
  })

  it.each([
    ['a phone that reads no early tab', OLD_PHONE, replayLaunch],
    ['a phone launch with no operation id', PHONE, plainLaunch]
  ] as const)(
    'leaves the desktop where it is when the agent spawns with no tab shown first: %s',
    async (_name, context, run) => {
      const runtime = hostWithWindow()

      await run(runtime, {}, context)

      expect(runtime.published).toHaveLength(0)
      expect(terminalOptions(runtime)).toMatchObject({ surfaceOwner: false })
    }
  )

  it('still reveals a local launch that spawns with no tab shown first', async () => {
    const runtime = hostWithWindow()

    await plainLaunch(runtime, {}, CLI)

    expect(runtime.published).toHaveLength(0)
    expect(runtime.createTerminal).toHaveBeenCalledOnce()
    expect(terminalOptions(runtime)).not.toHaveProperty('surfaceOwner')
  })

  it("moves the phone's own selection unless it asked for the background", async () => {
    const focused = hostWithWindow({ terminalPaneKey: PANE_KEY })
    await replayLaunch(focused, { paneKey: PANE_KEY }, PHONE)
    expect(focused.selectCreatedMobileSessionTabForClient).toHaveBeenCalledOnce()

    const background = hostWithWindow({ terminalPaneKey: PANE_KEY })
    await replayLaunch(background, { paneKey: PANE_KEY, presentation: 'background' }, PHONE)
    expect(background.selectCreatedMobileSessionTabForClient).not.toHaveBeenCalled()
  })
})

describe('the view the tab opens in', () => {
  const CHAT_VIEW = { experimentalNativeChat: true, openAgentTabsInChatByDefault: true }

  it('is derived on the host, the same for the shown tab and the spawn', async () => {
    const runtime = hostWithWindow({ settings: CHAT_VIEW })

    await replayLaunch(runtime, {}, CLI)

    expect(runtime.published[0]?.viewMode).toBe('chat')
    expect(terminalOptions(runtime)).toMatchObject({ viewMode: 'chat' })
  })

  it('stays the terminal for a draft the chat view cannot mirror', async () => {
    const runtime = hostWithWindow({ settings: CHAT_VIEW })

    await replayLaunch(runtime, { prompt: { text: '   ', delivery: 'draft' } }, CLI)

    expect(runtime.published[0]?.viewMode).toBe('terminal')
    expect(terminalOptions(runtime)).toMatchObject({ viewMode: 'terminal' })
  })
})

it('hands the window the prompt, so a pane whose agent did not start can offer to copy it', async () => {
  const runtime = hostWithWindow()
  await replayLaunch(runtime, { prompt: { text: 'fix the build', delivery: 'submit' } }, CLI)
  expect(runtime.published[0]?.prompt).toBe('fix the build')
})

it('parses the minted pane key the window was given', async () => {
  const runtime = hostWithWindow()
  await replayLaunch(runtime, {}, CLI)
  const request = runtime.published[0]!
  expect(parsePaneKey(`${request.tabId}:${request.leafId}`)).not.toBeNull()
})
