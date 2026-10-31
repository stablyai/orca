import { RuntimeClientCapabilities } from '../runtime-client-capabilities'
import { RUNTIME_CLIENT_CAPABILITY_METHODS } from './runtime-client-capabilities'
import { visibleSnapshot } from './session-tabs-snapshot.test-fixture'
import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY,
  SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { createSessionTabsTabDeltaDecoder } from '../../../../shared/session-tabs-tab-delta'
import { RpcDispatcher } from '../dispatcher'
import { SESSION_TAB_METHODS } from './session-tabs'

const WORKTREE = 'wt-1'
const TABS = 17

const uuid = (index: number): string =>
  `${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`

// The shape a headless host publishes for a Claude Code pane with a hook status row.
function agentTab(index: number, status: { toolInput: string; message: string }) {
  const leafId = uuid(index)
  const terminal = `term_${uuid(index + 1000)}`
  return {
    type: 'terminal' as const,
    id: `tab-${index}::${leafId}`,
    parentTabId: `tab-${index}`,
    leafId,
    title: 'Terminal',
    ptyId: `pty-${index}`,
    launchAgent: 'claude',
    agentStatus: {
      state: 'working',
      prompt: `Fix the flaky test number ${index} in the suite`,
      agentType: 'claude',
      toolInput: status.toolInput,
      lastAssistantMessage: status.message,
      paneKey: `tab-${index}:${leafId}`,
      updatedAt: 1_792_103_399_611,
      stateStartedAt: 1,
      stateHistory: [],
      terminalHandle: terminal,
      worktreeId: WORKTREE,
      tabId: `tab-${index}`,
      terminalTitle: 'Terminal'
    },
    parentLayout: {
      root: { type: 'leaf', leafId },
      activeLeafId: leafId,
      expandedLeafId: null,
      ptyIdsByLeafId: { [leafId]: `pty-${index}` }
    },
    isActive: index === 0,
    status: 'ready',
    terminal
  }
}

function snapshot(version: number, changedTab?: number): RuntimeMobileSessionTabsResult {
  const tabs = Array.from({ length: TABS }, (_, index) =>
    agentTab(
      index,
      index === changedTab
        ? { toolInput: `pnpm test src/file-${version}.test.ts`, message: `Looking at ${version}` }
        : { toolInput: 'pnpm test', message: 'Looking at the suite' }
    )
  )
  return {
    worktree: WORKTREE,
    publicationEpoch: 'headless:pty-backed:epoch',
    snapshotVersion: version,
    activeGroupId: `headless-terminals:${WORKTREE}`,
    activeTabId: tabs[0]!.id,
    activeTabType: 'terminal',
    tabGroups: [
      {
        id: `headless-terminals:${WORKTREE}`,
        activeTabId: 'tab-0',
        tabOrder: tabs.map((tab) => tab.parentTabId)
      }
    ],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture mirrors a published headless terminal tab; the union's other members are irrelevant here.
    tabs: tabs as unknown as RuntimeMobileSessionTabsResult['tabs']
  }
}

async function runStream(
  method: 'session.tabs.subscribe' | 'session.tabs.subscribeAll',
  clientCapabilities: readonly string[]
): Promise<string[]> {
  let listener: ((next: RuntimeMobileSessionTabsResult, changeSequence: number) => void) | null =
    null
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stream handlers call only the runtime members stubbed here.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    getClientSettings: () => ({}),
    listMobileSessionTabs: vi.fn().mockResolvedValue(snapshot(1)),
    supportsAuthoritativeSessionTabsInventory: () => false,
    listAllMobileSessionTabsWithChangeSequence: vi
      .fn()
      .mockResolvedValue({ snapshots: [snapshot(1)], changeSequence: 1 }),
    registerSubscriptionCleanup: vi.fn(),
    cleanupSubscription: vi.fn(),
    onMobileSessionTabsChanged: vi.fn((next: typeof listener) => {
      listener = next
      return () => {}
    })
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
  const messages: string[] = []
  await dispatcher.dispatchStreaming(
    {
      id: 'req-1',
      authToken: 'tok',
      method,
      params: method === 'session.tabs.subscribe' ? { worktree: `id:${WORKTREE}` } : undefined
    },
    (message) => messages.push(message),
    { clientKind: 'runtime', connectionId: 'conn-1', clientCapabilities }
  )
  await vi.waitFor(() => expect(listener).not.toBeNull())
  for (let version = 2; version <= 31; version += 1) {
    listener!(snapshot(version, version % 3), version)
  }
  return messages
}

function results(messages: string[]): unknown[] {
  return messages.map((message) => JSON.parse(message).result)
}

const bytes = (messages: string[]): number =>
  messages.reduce((total, message) => total + message.length, 0)

describe.each(['session.tabs.subscribe', 'session.tabs.subscribeAll'] as const)(
  '%s tab delta',
  (method) => {
    it('keeps sending full frames to a client that did not advertise it', async () => {
      const legacy = await runStream(method, [])
      expect(legacy).toHaveLength(31)
      for (const result of results(legacy).slice(1)) {
        expect(result).toHaveProperty('tabs')
        expect(result).not.toHaveProperty('tabsDelta')
        expect(result).not.toHaveProperty('tabsRevision')
      }
    })

    it('sends the same frame count at under a quarter of the bytes, decoding to the legacy frames', async () => {
      const legacy = await runStream(method, [])
      const delta = await runStream(method, [SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY])
      expect(delta).toHaveLength(legacy.length)
      // Measured here: ~11 KB legacy vs ~2.5 KB delta per one-tab change on a 17-tab worktree.
      const legacyUpdateBytes = bytes(legacy.slice(1)) / 30
      const deltaUpdateBytes = bytes(delta.slice(1)) / 30
      expect(legacyUpdateBytes).toBeGreaterThan(10_000)
      expect(deltaUpdateBytes).toBeLessThan(3_000)
      expect(deltaUpdateBytes * 4).toBeLessThan(legacyUpdateBytes)
      const decoder = createSessionTabsTabDeltaDecoder()
      expect(
        results(delta).map((result) => {
          const decoded = decoder.decode(result)
          return decoded.ok ? decoded.result : 'out-of-sync'
        })
      ).toEqual(results(legacy))
    })
  }
)

describe.each(['session.tabs.subscribe', 'session.tabs.subscribeAll'] as const)(
  '%s capability recovery',
  (method) => {
    it.each([false, true])(
      'reprojects on the same stream with opening delta support=%s',
      async (delta) => {
        const source = new RuntimeClientCapabilities()
        source.replace(
          delta
            ? [
                SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY,
                SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY
              ]
            : []
        )
        const changed = vi.fn<(value: RuntimeMobileSessionTabsResult, sequence: number) => void>()
        let listener: typeof changed = changed
        const cleanups = new Map<string, () => void>()
        const initial: RuntimeMobileSessionTabsResult = {
          ...visibleSnapshot(),
          retiredTerminalSurfaces: [
            {
              parentTabId: 'retired',
              leafId: 'leaf',
              ptyId: 'pty',
              terminal: 'term_1',
              incarnationId: 'inc'
            }
          ],
          tabs: [
            {
              type: 'agent-session',
              id: 'claude',
              sessionId: 'claude-session',
              agent: 'claude',
              title: 'Claude chat',
              isActive: true
            },
            {
              type: 'agent-session',
              id: 'codex',
              sessionId: 'codex-session',
              agent: 'codex',
              title: 'Codex chat',
              isActive: false
            }
          ]
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these real RPC handlers reach only the runtime members stubbed here.
        const runtime = {
          getRuntimeId: () => 'runtime',
          getClientSettings: () => ({}),
          listMobileSessionTabs: async () => initial,
          supportsAuthoritativeSessionTabsInventory: () => false,
          listAllMobileSessionTabsWithChangeSequence: async () => ({
            snapshots: [initial],
            changeSequence: 1
          }),
          registerSubscriptionCleanup: (id: string, cleanup: () => void) =>
            cleanups.set(id, cleanup),
          cleanupSubscription: (id: string) => cleanups.get(id)?.(),
          onMobileSessionTabsChanged: (callback: typeof listener) => {
            listener = callback
            return () => {}
          }
        } as unknown as OrcaRuntimeService
        const dispatcher = new RpcDispatcher({
          runtime,
          methods: [...SESSION_TAB_METHODS, ...RUNTIME_CLIENT_CAPABILITY_METHODS]
        })
        const messages: string[] = []
        const options = {
          clientKind: 'mobile' as const,
          connectionId: 'phone',
          clientCapabilities: source.current,
          capabilitySource: source,
          updateClientCapabilities: (next: readonly string[]) => source.replace(next)
        }
        await dispatcher.dispatchStreaming(
          {
            id: 'stream',
            authToken: 'tok',
            method,
            params: method === 'session.tabs.subscribe' ? { worktree: 'id:wt-1' } : undefined
          },
          (raw) => messages.push(raw),
          options
        )
        const primaryListener = listener
        const siblingSource = new RuntimeClientCapabilities()
        const siblingMessages: string[] = []
        await dispatcher.dispatchStreaming(
          {
            id: 'sibling',
            authToken: 'tok',
            method,
            params: method === 'session.tabs.subscribe' ? { worktree: 'id:wt-1' } : undefined
          },
          (raw) => siblingMessages.push(raw),
          { ...options, connectionId: 'other-phone', capabilitySource: siblingSource }
        )
        const decoder = createSessionTabsTabDeltaDecoder()
        const decode = (raw: string) => {
          const result = decoder.decode(JSON.parse(raw).result)
          if (!result.ok) {
            throw new Error('invalid stream baseline')
          }
          return result.result
        }
        expect(JSON.stringify(decode(messages[0]!))).toContain('Open on desktop')
        expect(messages).toHaveLength(1)
        const update = async (caps: string[]) => {
          await dispatcher.dispatchStreaming(
            {
              id: 'upgrade',
              authToken: 'tok',
              method: 'runtime.clientCapabilities.update',
              params: { clientCapabilities: caps }
            },
            () => {},
            options
          )
        }
        const structured = [
          'agent-session.structured.v1',
          'agent-session.structured.claude.v1',
          SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY,
          SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY
        ]
        // A capability the projection ignores sends no frame; the next real change still decodes.
        await update([...source.current, 'unrelated.test.v1'])
        expect(messages).toHaveLength(1)
        await update(structured)
        expect(siblingMessages).toHaveLength(1)
        expect(messages).toHaveLength(2)
        const recovered = decode(messages[1]!)
        expect(JSON.stringify(recovered)).toContain('Claude chat')
        const proofState = { retiredTerminalSurfaces: delta ? [] : initial.retiredTerminalSurfaces }
        expect(recovered).toMatchObject(proofState)
        if (!delta) {
          expect(JSON.parse(messages[1]!).result).not.toHaveProperty('tabsRevision')
        }
        const renamed = {
          ...initial,
          snapshotVersion: 2,
          tabs: initial.tabs.map((tab) => ({ ...tab, title: `${tab.title} renamed` }))
        }
        primaryListener(renamed, 2)
        expect(JSON.stringify(decode(messages[2]!))).toContain('Claude chat renamed')
        primaryListener(renamed, 3)
        if (method === 'session.tabs.subscribeAll') {
          expect(messages).toHaveLength(3)
        } else {
          decode(messages[3]!)
        }
        const beforeLoss = messages.length
        await update([])
        expect(JSON.stringify(decode(messages[beforeLoss]!))).toContain('Open on desktop')
        expect(siblingMessages).toHaveLength(1)
        const count = messages.length
        for (const cleanup of cleanups.values()) {
          cleanup()
        }
        await update(['agent-session.structured.v1'])
        expect(messages.slice(count).map((raw) => JSON.parse(raw).result.type)).toEqual(['end'])
      }
    )
  }
)
