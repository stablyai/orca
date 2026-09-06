import { describe, expect, it, vi } from 'vitest'
import { MOBILE_WEB_BRIDGE_MAX_PENDING_REQUESTS } from '../../../src/shared/mobile-web/bridge-limits'
import type { RpcClient } from '../transport/rpc-client'
import {
  createMobileWebBrokerFixture,
  mobileWebBridgeRequestMessage
} from './mobile-web-bridge-roundtrip-fixture'
import { MOBILE_WEB_PRODUCTION_GRANT_INDEX } from './mobile-web-production-grants'

const WORKSPACE = `workspace_0_${'01'.repeat(16)}`

type Slot = { capability: string; operation: string; payload: unknown }

// Distinct operations, so saturation is reached through the shared cap rather than through any
// single operation's maxConcurrent. Each one parks on a host call that never settles.
const SATURATION_SLOTS: Slot[] = [
  { capability: 'workspace', operation: 'snapshot', payload: {} },
  { capability: 'workspace', operation: 'repositories', payload: {} },
  { capability: 'workspace', operation: 'activate', payload: { workspaceId: WORKSPACE } },
  { capability: 'workspace', operation: 'remove', payload: { workspaceId: WORKSPACE } },
  { capability: 'settings', operation: 'snapshot', payload: {} },
  { capability: 'settings', operation: 'update', payload: {} },
  { capability: 'account', operation: 'snapshot', payload: {} },
  { capability: 'task', operation: 'bootstrap', payload: {} },
  { capability: 'task', operation: 'repositories', payload: {} },
  { capability: 'task', operation: 'linearContext', payload: {} },
  { capability: 'task', operation: 'listLinearTeams', payload: {} },
  { capability: 'task', operation: 'selectLinearWorkspace', payload: { workspaceId: WORKSPACE } },
  { capability: 'session', operation: 'capabilities', payload: {} },
  { capability: 'session', operation: 'snapshot', payload: { workspaceId: WORKSPACE } },
  {
    capability: 'session',
    operation: 'activate',
    payload: { workspaceId: WORKSPACE, tabId: 'tab-1' }
  },
  { capability: 'session', operation: 'create', payload: { workspaceId: WORKSPACE } },
  { capability: 'session', operation: 'agentOptions', payload: { workspaceId: WORKSPACE } },
  { capability: 'session', operation: 'quickCommands', payload: { workspaceId: WORKSPACE } },
  {
    capability: 'session',
    operation: 'createAgent',
    payload: { workspaceId: WORKSPACE, agent: 'claude' }
  },
  {
    capability: 'session',
    operation: 'close',
    payload: { workspaceId: WORKSPACE, tabId: 'tab-1' }
  },
  { capability: 'file', operation: 'list', payload: { workspaceId: WORKSPACE } },
  {
    capability: 'file',
    operation: 'search',
    payload: { workspaceId: WORKSPACE, query: '', limit: 10 }
  },
  { capability: 'file', operation: 'directory', payload: { workspaceId: WORKSPACE } },
  {
    capability: 'file',
    operation: 'read',
    payload: { workspaceId: WORKSPACE, relativePath: 'src/app.ts' }
  },
  {
    capability: 'file',
    operation: 'readChunk',
    payload: { workspaceId: WORKSPACE, relativePath: 'src/app.ts', offset: 0, length: 10 }
  },
  {
    capability: 'file',
    operation: 'markdownDraftRead',
    payload: { workspaceId: WORKSPACE, tabId: 'tab-1' }
  },
  {
    capability: 'file',
    operation: 'open',
    payload: { workspaceId: WORKSPACE, relativePath: 'src/app.ts' }
  },
  { capability: 'sourceControl', operation: 'status', payload: { workspaceId: WORKSPACE } },
  { capability: 'sourceControl', operation: 'branches', payload: { workspaceId: WORKSPACE } },
  { capability: 'sourceControl', operation: 'history', payload: { workspaceId: WORKSPACE } },
  { capability: 'sourceControl', operation: 'reviewMetadata', payload: { workspaceId: WORKSPACE } },
  { capability: 'sourceControl', operation: 'reviewLink', payload: { workspaceId: WORKSPACE } },
  {
    capability: 'sourceControl',
    operation: 'cancelCommitMessageGeneration',
    payload: { workspaceId: WORKSPACE }
  },
  { capability: 'sourceControl', operation: 'upstream', payload: { workspaceId: WORKSPACE } },
  { capability: 'speech', operation: 'setup', payload: {} },
  { capability: 'speech', operation: 'start', payload: {} },
  { capability: 'native', operation: 'clipboardAvailability', payload: {} },
  { capability: 'native', operation: 'clipboardWrite', payload: { text: 'x' } },
  { capability: 'native', operation: 'openExternal', payload: { url: 'https://example.com' } },
  { capability: 'native', operation: 'terminalPreferences', payload: {} },
  { capability: 'nativeChat', operation: 'readability', payload: { workspaceId: WORKSPACE } },
  { capability: 'workspace', operation: 'creationRepositories', payload: {} },
  { capability: 'workspace', operation: 'creationSettings', payload: {} },
  { capability: 'workspace', operation: 'creationTrustedHooks', payload: {} },
  { capability: 'workspace', operation: 'creationGitLabAvailability', payload: {} },
  { capability: 'workspace', operation: 'creationLinearAvailability', payload: {} },
  { capability: 'workspace', operation: 'creationRuntimeCapabilities', payload: {} }
]

// Held out of the fill so the overflow probe is an operation with its own budget untouched.
const OVERFLOW_SLOT: Slot = {
  capability: 'native',
  operation: 'terminalAccessoryPreferences',
  payload: {}
}

describe('mobile web capability broker backpressure', () => {
  it('accepts the overflow operation while the shared pending budget has room', async () => {
    const harness = createHarness()
    await primeWorkspaceAuthority(harness)
    const before = harness.messages.length

    await harness.send(OVERFLOW_SLOT, 'Z'.repeat(22))

    expect(harness.messages.slice(before)).toEqual([])
  })

  it('refuses a new operation once the shared pending-request cap is saturated', async () => {
    const harness = await createSaturatedHarness()

    expect(harness.accepted).toBe(MOBILE_WEB_BRIDGE_MAX_PENDING_REQUESTS)

    await harness.send(OVERFLOW_SLOT, 'Z'.repeat(22))

    expect(harness.messages.at(-1)).toMatchObject({
      type: 'response',
      requestId: 'Z'.repeat(22),
      status: 'error',
      error: { code: 'rate_limited', retryable: true }
    })
  }, 30_000)

  it('refuses a host payload larger than the operation response budget', async () => {
    const budget = requiredGrant('native.terminalAccessoryPreferences').limits.maxResponseBytes
    const accessoryPreferences = vi.fn().mockResolvedValue(customKeys(1))
    const harness = createHarness({ terminalAccessoryPreferences: accessoryPreferences })

    await harness.send(OVERFLOW_SLOT, 'S'.repeat(22))
    expect(harness.messages.at(-1)).toMatchObject({ status: 'success' })

    const oversize = customKeys(32)
    expect(new TextEncoder().encode(JSON.stringify(oversize)).byteLength).toBeGreaterThan(budget)
    accessoryPreferences.mockResolvedValue(oversize)
    await harness.send(OVERFLOW_SLOT, 'T'.repeat(22))

    expect(harness.messages.at(-1)).toMatchObject({
      type: 'response',
      requestId: 'T'.repeat(22),
      status: 'error',
      error: { code: 'unavailable', retryable: false }
    })
  })
})

// Schema-valid accessory preferences; 32 keys of 4096 bytes each clear the response budget.
function customKeys(count: number) {
  return {
    customKeys: Array.from({ length: count }, (_, index) => ({
      id: `key-${index}`,
      label: `k${index}`,
      bytes: 'b'.repeat(4096),
      enter: false
    })),
    orderedBuiltInIds: [],
    visibleBuiltInIds: []
  }
}

function requiredGrant(key: string) {
  const grant = MOBILE_WEB_PRODUCTION_GRANT_INDEX.get(key)
  if (!grant) {
    throw new Error(`missing production grant for ${key}`)
  }
  return grant
}

async function createSaturatedHarness() {
  const harness = createHarness()
  await primeWorkspaceAuthority(harness)
  harness.sendRequest.mockImplementation(() => new Promise(() => {}) as never)
  harness.subscribe.mockImplementation(() => new Promise(() => {}) as never)

  const used = SATURATION_SLOTS.map(() => 0)
  let accepted = 0
  let id = 0
  for (const [index, slot] of SATURATION_SLOTS.entries()) {
    const key = `${slot.capability}.${slot.operation}`
    for (let taken = 0; taken < requiredGrant(key).limits.maxConcurrent; taken += 1) {
      if (accepted >= MOBILE_WEB_BRIDGE_MAX_PENDING_REQUESTS) {
        break
      }
      id += 1
      const before = harness.messages.length
      await harness.send(slot, String(id).padStart(22, 'A'))
      if (harness.messages.length !== before) {
        // The slot hit its own per-operation budget first; take the rest from later slots.
        break
      }
      used[index] += 1
      accepted += 1
    }
  }
  return { ...harness, accepted, used }
}

function createHarness(nativeAuthority: Record<string, unknown> = {}) {
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const subscribe = vi.fn<RpcClient['subscribe']>()
  const client = { sendRequest, subscribe } as unknown as RpcClient
  const park = () => new Promise<never>(() => {})
  const { broker, messages } = createMobileWebBrokerFixture({
    getClient: () => client,
    isConnected: () => true,
    isActive: () => true,
    nativeAuthority: {
      clipboardAvailability: park,
      clipboardWrite: park,
      openExternal: park,
      terminalPreferences: park,
      terminalAccessoryPreferences: park,
      ...nativeAuthority
    },
    randomBytes: (length) => new Uint8Array(length).fill(1),
    now: () => 1000
  })
  const send = async (slot: Slot, requestId: string): Promise<void> => {
    void broker.handle(mobileWebBridgeRequestMessage({ requestId, ...slot }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { broker, messages, sendRequest, subscribe, send }
}

async function primeWorkspaceAuthority(harness: ReturnType<typeof createHarness>): Promise<void> {
  harness.sendRequest.mockResolvedValueOnce({
    ok: true,
    result: { worktrees: [{ worktreeId: 'workspace-1', repoId: 'repo-1' }] }
  } as never)
  await harness.broker.handle(
    mobileWebBridgeRequestMessage({
      requestId: 'P'.repeat(22),
      capability: 'workspace',
      operation: 'snapshot',
      payload: { limit: 1 }
    })
  )
}
