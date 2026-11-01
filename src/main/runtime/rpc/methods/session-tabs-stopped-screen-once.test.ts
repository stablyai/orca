import { visibleSnapshot } from './session-tabs-snapshot.test-fixture'
import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { RpcDispatcher } from '../dispatcher'
import { SESSION_TAB_METHODS } from './session-tabs'

const IMAGE = 'HELD-IMAGE'.repeat(1_000)

/** A stopped pane beside one whose title ticks every frame; counts each time its image is serialized. */
function stoppedWorkspace() {
  let serializations = 0
  const screen = {
    data: IMAGE,
    cols: 100,
    rows: 30,
    toJSON: () => {
      serializations += 1
      return { data: IMAGE, cols: 100, rows: 30 }
    }
  }
  const base = visibleSnapshot()
  const stoppedRow = {
    ...base.tabs[0]!,
    id: 'tab-2::leaf-2',
    parentTabId: 'tab-2',
    leafId: 'leaf-2',
    terminal: 'pty-2',
    isActive: false,
    stoppedSwitchSource: {
      ptyId: 'pty-2',
      incarnationId: 'incarnation-2',
      agent: 'codex' as const,
      providerSessionId: 'conversation',
      screen
    }
  }
  const frame = (version: number): RuntimeMobileSessionTabsResult => ({
    ...base,
    snapshotVersion: version,
    tabs: [{ ...base.tabs[0]!, title: `Working ${version}` }, stoppedRow]
  })
  return { frame, serializations: () => serializations }
}

async function runStream(
  method: 'session.tabs.subscribe' | 'session.tabs.subscribeAll',
  clientCapabilities: readonly string[],
  frames: number,
  workspace: ReturnType<typeof stoppedWorkspace>
): Promise<string[]> {
  let listener: ((next: RuntimeMobileSessionTabsResult, changeSequence: number) => void) | null =
    null
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stream handlers call only the runtime members stubbed here.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    getClientSettings: () => ({}),
    listMobileSessionTabs: vi.fn().mockResolvedValue(workspace.frame(1)),
    supportsAuthoritativeSessionTabsInventory: () => false,
    listAllMobileSessionTabsWithChangeSequence: vi
      .fn()
      .mockResolvedValue({ snapshots: [workspace.frame(1)], changeSequence: 1 }),
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
      params: method === 'session.tabs.subscribe' ? { worktree: 'id:wt-1' } : undefined
    },
    (message) => messages.push(message),
    { clientKind: 'runtime', connectionId: 'conn-1', clientCapabilities }
  )
  await vi.waitFor(() => expect(listener).not.toBeNull())
  for (let version = 2; version <= frames + 1; version += 1) {
    listener!(workspace.frame(version), version)
  }
  return messages
}

describe.each(['session.tabs.subscribe', 'session.tabs.subscribeAll'] as const)(
  '%s stopped pane screen',
  (method) => {
    it.each([
      ['a delta client', [SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY]],
      ['a full-frame client', []]
    ] as const)(
      'serializes the image once per stream for %s, at N and 10N frames',
      async (_, caps) => {
        for (const frames of [20, 200]) {
          const workspace = stoppedWorkspace()
          const messages = await runStream(method, caps, frames, workspace)
          expect(messages).toHaveLength(frames + 1)
          expect(messages[0]).toContain(IMAGE)
          expect(messages.filter((message) => message.includes(IMAGE))).toHaveLength(1)
          expect(workspace.serializations()).toBeLessThanOrEqual(2)
          // A new stream (a reload, another client) opens with it again.
          const next = await runStream(method, caps, 1, workspace)
          expect(next[0]).toContain(IMAGE)
        }
      }
    )
  }
)
