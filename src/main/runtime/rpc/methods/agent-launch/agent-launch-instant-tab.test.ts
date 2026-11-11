/** Drive the RPC handler and durable ledger to prove early tab publication precedes admission and spawn uses that pane. */

import { closeTestJournalHostDatabases } from '../../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'

import { mkdtemp, rm } from 'node:fs/promises'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_TAB_CLOSED_CLIENT_CAPABILITY,
  AGENT_LAUNCH_UNSTARTED_TAB_CLIENT_CAPABILITY
} from '../../../../../shared/agent-launch/contracts/agent-launch-runtime-capability'

import { AGENT_LAUNCH_TAB_CLOSED_CODE } from '../../../../../shared/agent-launch/contracts/agent-launch-tab-closed'

import '../../../../../shared/agent-launch/contracts/agent-launch-replay-refusal'
import '../../errors'
import type { AgentLaunchResult } from '../../../../../shared/agent-launch/contracts/agent-launch-intent'

import type {
  AgentLaunchTabPublished,
  AgentLaunchTabPublishRequest
} from '../../../../../shared/agent-launch/contracts/agent-launch-tab-publication'

import '../../../../../shared/workspace-layout/stable-pane-id'
import {
  markAgentLaunchesClosedByUser,
  resetAgentLaunchPanesForTests,
  resolveAgentLaunchPaneVerdict
} from '../../../../agent-launch/agent-launch-pane-attachment'

import type { AgentLaunchPaneVerdict } from '../../../../../shared/agent-launch/contracts/agent-launch-pane-verdict'

import type { AgentSessionRecordStore } from '../../../agent-session/records/agent-session-record-store'

import { openTestAgentSessionRecordStore } from '../../../agent-session/records/agent-session-record-store-test-harness'

import type { RpcContext } from '../../core'

import '../../rpc-caller-identity'
import {
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore,
  type AgentLaunchRuntimeStubOptions
} from './agent-launch.test-fixture'

import {
  WORKTREE_ID as MAIN_WORKTREE_ID,
  setupMainOwnedWorkspace
} from '../../../terminal/layout/main-owned-workspace-runtime-fixture'

const deliverTerminalAgentLaunchPrompt = vi.hoisted(() => vi.fn(async () => true))
vi.mock('./agent-launch-terminal-prompt', () => ({ deliverTerminalAgentLaunchPrompt }))
// Every case runs in both builds: the window shows the tab, or (layout owner) main writes it.
const layoutOwner = vi.hoisted(() => ({ isMain: false }))
vi.mock('../../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH_REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')

const TAB_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const LEAF_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const TERMINAL_ONLY = {}
const LAUNCH = { agent: 'claude', target: { kind: 'existing', worktree: 'id:wt-7' } }
const CLI: Partial<RpcContext> = {}
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
  await closeTestJournalHostDatabases()
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
    selectCreatedMobileSessionTabForClient: vi.fn(() => true),
    // Stand in for main's layout write so both builds share fakes.
    publishAgentLaunchTabInMainLayout: vi.fn(
      (request: Omit<AgentLaunchTabPublishRequest, 'requestId'>) =>
        runtime.publishAgentLaunchTab(request)
    ),
    withdrawAgentLaunchPaneInMainLayout: vi.fn(
      (_address: { worktreeId: string; tabId: string; leafId: string }) => true
    )
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

/** What the pane's spawn decides when it mounts; `unowned` is an ordinary pane's spawn. */
async function paneVerdict(
  runtime: Host,
  paneKey = PANE_KEY
): Promise<AgentLaunchPaneVerdict | 'unowned'> {
  return (
    (await resolveAgentLaunchPaneVerdict({ worktreeId: 'wt-7', paneKey }, (key) =>
      runtime.hasLiveTerminalForPaneKey(key)
    )) ?? 'unowned'
  )
}

/** The record not open yet when the request arrives, as on the first launch after a restart. */
function coldRecord(runtime: Host): Host {
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

describe.each(['window', 'main'] as const)('the %s owning the layout', (owner) => {
  beforeEach(() => {
    layoutOwner.isMain = owner === 'main'
  })
  afterEach(() => {
    layoutOwner.isMain = false
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

    it('still stops the launch as closed when its attached tab is closed before the prompt lands', async () => {
      const runtime = hostWithWindow({ terminalPaneKey: PANE_KEY, lineCarriesPrompt: false })
      const { launched, deliver } = launchDeliveringSlowly(runtime)
      await vi.waitFor(() => expect(deliverTerminalAgentLaunchPrompt).toHaveBeenCalled())
      await expect(paneVerdict(runtime)).resolves.toEqual({ kind: 'proceed' })

      markAgentLaunchesClosedByUser('wt-7', { kind: 'tab', tabId: TAB_ID })
      deliver(true)

      await expect(launched).rejects.toMatchObject({ code: AGENT_LAUNCH_TAB_CLOSED_CODE })
      expect(runtime.closeTerminal).toHaveBeenCalledWith('term_1')
    })
  })

  describe('the pane after its launch', () => {
    it('says a failed spawn did not start and keeps the tab; after a restart it is an ordinary pane', async () => {
      const runtime = hostWithWindow()
      failBeforeDispatch(runtime, 'spawn claude ENOENT')

      await expect(replayLaunch(runtime, { paneKey: PANE_KEY }, CLI)).rejects.toThrow('ENOENT')

      // Kept, and told: the tab keeps the outcome even if its pane never mounts.
      expect(runtime.reportAgentLaunchPaneVerdict).not.toHaveBeenCalledWith(expect.anything(), {
        kind: 'withdrawn'
      })
      await vi.waitFor(() =>
        expect(runtime.reportAgentLaunchPaneVerdict).toHaveBeenCalledWith(
          { worktreeId: 'wt-7', tabId: TAB_ID, leafId: LEAF_ID },
          { kind: 'not-started', code: 'spawn claude ENOENT' }
        )
      )
      // A spawn of the pane after the verdict, in this process: refused the same way, no shell.
      await expect(paneVerdict(runtime)).resolves.toEqual({
        kind: 'not-started',
        code: 'spawn claude ENOENT'
      })
      // A restarted host: no launch in memory, and the record is not read for the pane.
      resetAgentLaunchPanesForTests()
      await expect(paneVerdict(hostWithWindow())).resolves.toBe('unowned')
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
      // Once its agent has bound, the pane is an ordinary one.
      runtime.hasLiveTerminalForPaneKey.mockReturnValue(false)
      await expect(paneVerdict(runtime)).resolves.toBe('unowned')
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
      await expect(paneVerdict(second)).resolves.toBe('unowned')
    })

    it('takes back a tab nothing ran into without letting its waiting pane start a shell', async () => {
      const operationId = nextOperationId()
      await replayLaunch(hostWithWindow({ terminalPaneKey: PANE_KEY }), { operationId }, CLI)

      const verdicts: Promise<AgentLaunchPaneVerdict | 'unowned'>[] = []
      const refused = coldRecord(hostWithWindow())
      const publish = refused.publishAgentLaunchTab.getMockImplementation()!
      refused.publishAgentLaunchTab.mockImplementation((request) => {
        const published = publish(request)
        verdicts.push(paneVerdict(refused, `${request.tabId}:${request.leafId}`))
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

    it('takes back its tab and spawns nothing when the launch record cannot open', async () => {
      const runtime = hostWithWindow()
      const verdicts: Promise<AgentLaunchPaneVerdict | 'unowned'>[] = []
      const publish = runtime.publishAgentLaunchTab.getMockImplementation()!
      runtime.publishAgentLaunchTab.mockImplementation((request) => {
        const published = publish(request)
        verdicts.push(paneVerdict(runtime, `${request.tabId}:${request.leafId}`))
        return published
      })
      runtime.openAgentSessionRecordStore.mockRejectedValueOnce(new Error('EACCES'))

      await expect(replayLaunch(runtime, { paneKey: PANE_KEY }, CLI)).rejects.toThrow('EACCES')

      expect(runtime.createTerminal).not.toHaveBeenCalled()
      await expect(verdicts[0]).resolves.toEqual({ kind: 'withdrawn' })
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

    it('tells a caller that cannot read the word what it always heard', async () => {
      const operationId = nextOperationId()
      const runtime = hostWithWindow({ terminalPaneKey: PANE_KEY })
      closeTabWhenShown(runtime)

      await expect(
        replayLaunch(runtime, { paneKey: PANE_KEY, operationId }, PHONE)
      ).rejects.toThrow('agent_session_operation_unknown')
      await expect(
        replayLaunch(hostWithWindow(), { paneKey: PANE_KEY, operationId }, PHONE)
      ).rejects.toThrow('agent_session_operation_unknown')
      await expect(
        replayLaunch(hostWithWindow(), { paneKey: PANE_KEY, operationId }, PHONE_READING_TAB_CLOSED)
      ).rejects.toThrow(AGENT_LAUNCH_TAB_CLOSED_CODE)
    })
  })

  describe('placement', () => {
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

  it.runIf(owner === 'main')(
    "writes and takes back the tab in main's real layout, and the window still hears why",
    async () => {
      const real = setupMainOwnedWorkspace()
      const target = { kind: 'existing', worktree: `id:${MAIN_WORKTREE_ID}` }
      const operationId = nextOperationId()
      await replayLaunch(
        hostWithWindow({ terminalPaneKey: PANE_KEY }),
        { operationId, target },
        CLI
      )
      const refused = coldRecord(hostWithWindow())
      refused.publishAgentLaunchTabInMainLayout.mockImplementation((request) =>
        real.runtime.publishAgentLaunchTabInMainLayout(request)
      )
      refused.withdrawAgentLaunchPaneInMainLayout.mockImplementation((address) =>
        real.runtime.withdrawAgentLaunchPaneInMainLayout(address)
      )
      const mainTabIds = () =>
        real.session().tabsByWorktree[MAIN_WORKTREE_ID]?.map((tab) => tab.id) ?? []
      refused.publishAgentLaunchTab.mockImplementation(() => {
        throw new Error('main wrote the tab; the window makes none')
      })

      await expect(
        replayLaunch(
          refused,
          {
            operationId,
            target,
            paneKey: PANE_KEY,
            prompt: { text: 'other', delivery: 'submit' }
          },
          CLI
        )
      ).rejects.toThrow('agent_session_operation_conflict')

      // Main wrote the launch's tab, then took it back: nothing ran in it.
      await expect(
        refused.publishAgentLaunchTabInMainLayout.mock.results[0]?.value
      ).resolves.toMatchObject({ tabId: TAB_ID, created: true })
      await vi.waitFor(() => expect(mainTabIds()).not.toContain(TAB_ID))
      expect(refused.reportAgentLaunchPaneVerdict).toHaveBeenCalledWith(
        { worktreeId: MAIN_WORKTREE_ID, tabId: TAB_ID, leafId: LEAF_ID },
        { kind: 'withdrawn' }
      )
    }
  )
})
