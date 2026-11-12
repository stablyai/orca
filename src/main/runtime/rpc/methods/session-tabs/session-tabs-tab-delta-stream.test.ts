import { RuntimeClientCapabilities } from '../../callers/runtime-client-capabilities'
import { RUNTIME_CLIENT_CAPABILITY_METHODS } from '../client-events/runtime-client-capabilities'
import { visibleSnapshot } from './session-tabs-snapshot.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import '../../../../../shared/protocol-version'
import {
  SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY,
  SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY
} from '../../../../../shared/session-tabs-runtime-capabilities'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'
import { createSessionTabsTabDeltaDecoder } from '../../../../../shared/session-tabs-tab-delta'
import { RpcDispatcher } from '../../dispatcher'
import { SESSION_TAB_METHODS } from './session-tabs'

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
        const observedFrames: RuntimeMobileSessionTabsResult[][] = []
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these real RPC handlers reach only the runtime members stubbed here.
        const runtime = {
          observeClientHostedPageSnapshots: (frames: RuntimeMobileSessionTabsResult[]) =>
            observedFrames.push(frames),
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
        expect(observedFrames).toHaveLength(2)
        await update(structured)
        expect(siblingMessages).toHaveLength(1)
        expect(messages).toHaveLength(2)
        expect(observedFrames).toHaveLength(3)
        expect(observedFrames.at(-1)?.[0]?.tabs[0]).toMatchObject({
          type: 'agent-session',
          title: 'Claude chat'
        })
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
