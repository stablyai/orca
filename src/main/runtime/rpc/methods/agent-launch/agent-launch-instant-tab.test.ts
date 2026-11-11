/** Drive the RPC handler and durable ledger to prove early tab publication precedes admission and spawn uses that pane. */

import { closeTestJournalHostDatabases } from '../../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'

import { mkdtemp, rm } from 'node:fs/promises'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  resetAgentLaunchPanesForTests
} from '../../../../agent-launch/agent-launch-pane-attachment'

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

describe.each(['window', 'main'] as const)('the %s owning the layout', (owner) => {
  beforeEach(() => {
    layoutOwner.isMain = owner === 'main'
  })
  afterEach(() => {
    layoutOwner.isMain = false
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
  })
})
