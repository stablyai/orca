import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
import { MOBILE_AI_VAULT_CAPABILITY } from '../agent-history/agent-history-capability'
import {
  readNewWorktreeRuntimeCapabilities,
  type NewWorktreeRuntimeCapabilities
} from '../tasks/worktree-create-capability'
import { supportsMobileQuickCommands } from '../terminal/quick-commands'
import { useHostStatusGates, type HostStatusGates } from './host-status-gates'
import {
  hostAnsweredStatusProbe,
  readProbedHostCapabilities,
  readProbedHostStatus
} from './host-status-probe-operations'
import type { HostStatusReply } from './host-status-reply-schema'
import type { RpcClient } from './rpc-client'
import type { RpcResponse } from './types'

const recordHostAppVersionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('./host-app-version-store', () => ({
  recordHostAppVersion: (...args: unknown[]) => recordHostAppVersionMock(...args)
}))

// Why: the recorder reaches the durable host store, which this hook-level suite never exercises.
vi.mock('./host-descriptor-recorder', () => ({
  recordHostDescriptorFromStatus: vi.fn()
}))

/**
 * What a desktop that ships a mobile web bundle now answers. The new name sits among real ones
 * rather than alone, so a reader that keeps only the head or the tail of the list cannot look
 * unchanged by accident, and the rest are there to make every derived state below non-trivial.
 */
const ADVERTISED_CAPABILITIES = [
  'files.pathsExist',
  MOBILE_AI_VAULT_CAPABILITY,
  'mobile.tasks.v1',
  MOBILE_WEB_BUNDLE_CAPABILITY,
  'worktree.create-idempotency.v1',
  'terminal.quick-commands.v1'
] as const

/** The old desktop is DERIVED, never written down: one string removed from what the new one sends. */
const OLD_DESKTOP_CAPABILITIES = ADVERTISED_CAPABILITIES.filter(
  (capability) => capability !== MOBILE_WEB_BUNDLE_CAPABILITY
)

function statusReply(capabilities: readonly string[]): RpcResponse {
  return {
    id: 'status-1',
    ok: true,
    result: {
      appVersion: '1.4.200',
      protocolVersion: 3,
      minCompatibleMobileVersion: 2,
      floatingWorkspaceEnabled: true,
      capabilities: [...capabilities]
    },
    _meta: { runtimeId: 'runtime-1' }
  }
}

/** Answers every method with the one status reply, which is all any reader under test asks for. */
function clientAnswering(reply: RpcResponse): RpcClient {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every reader below reaches this client only through an rpc operation's `request`, which uses sendRequest alone; the rest of RpcClient is streaming and lifecycle none of them touch.
  return { sendRequest: vi.fn().mockResolvedValue(reply) } as unknown as RpcClient
}

async function renderGates(client: RpcClient): Promise<HostStatusGates> {
  // Held on an object rather than in `let`s: both are written from inside a callback, where
  // narrowing would read them back as their initializer.
  const mount: { renderer?: ReactTestRenderer; gates?: HostStatusGates } = {}
  function Probe(): null {
    mount.gates = useHostStatusGates({ hostId: 'host-1', client, connState: 'connected' })
    return null
  }
  try {
    await act(async () => {
      mount.renderer = create(createElement(Probe))
      await Promise.resolve()
    })
  } finally {
    mount.renderer?.unmount()
  }
  if (!mount.gates) {
    throw new Error('the gate hook never rendered')
  }
  return mount.gates
}

type ClientVisibleOutcome = {
  gates: HostStatusGates
  gateStatus: HostStatusReply | null
  probedCapabilities: readonly string[] | null
  answeredProbe: boolean
  quickCommandsSupported: boolean
  worktreeCreateSupport: NewWorktreeRuntimeCapabilities
}

/** Every released path that reads status.get, plus the states derived from what it published. */
async function readEverything(capabilities: readonly string[]): Promise<ClientVisibleOutcome> {
  const reply = statusReply(capabilities)
  const client = clientAnswering(reply)
  const gates = await renderGates(client)
  return {
    gates,
    gateStatus: readProbedHostStatus(reply)?.status ?? null,
    probedCapabilities: readProbedHostCapabilities(reply),
    answeredProbe: hostAnsweredStatusProbe(reply),
    quickCommandsSupported: supportsMobileQuickCommands(gates.hostCapabilities),
    worktreeCreateSupport: await readNewWorktreeRuntimeCapabilities(client)
  }
}

function withoutBundleCapability(values: readonly string[]): string[] {
  return values.filter((capability) => capability !== MOBILE_WEB_BUNDLE_CAPABILITY)
}

/** The outcome with the one new string removed wherever it surfaced, and nothing else touched. */
function asIfNeverAdvertised(outcome: ClientVisibleOutcome): ClientVisibleOutcome {
  return {
    ...outcome,
    gates: {
      ...outcome.gates,
      hostCapabilities: withoutBundleCapability(outcome.gates.hostCapabilities)
    },
    gateStatus: outcome.gateStatus
      ? {
          ...outcome.gateStatus,
          ...(outcome.gateStatus.capabilities
            ? { capabilities: withoutBundleCapability(outcome.gateStatus.capabilities) }
            : {})
        }
      : outcome.gateStatus,
    probedCapabilities: outcome.probedCapabilities
      ? withoutBundleCapability(outcome.probedCapabilities)
      : outcome.probedCapabilities
  }
}

describe('mobileWeb.bundle.v1 on a released client', () => {
  /**
   * The Phase A promise: a desktop that starts advertising the bundle changes nothing a shipped
   * phone can observe. Both sides of the comparison come from the same list, so nothing here
   * records "what the old client had" and can rot out of step with it.
   *
   * A closed enum or an exhaustive switch over capabilities would land on the presence assertions
   * first: the strict schema drops a whole salvaged field rather than one entry, so the advertised
   * read would publish nothing and the equality below would fail with it.
   */
  it('changes nothing a released client reads apart from the capability string itself', async () => {
    const advertised = await readEverything(ADVERTISED_CAPABILITIES)
    const oldDesktop = await readEverything(OLD_DESKTOP_CAPABILITIES)

    // Preconditions: without these the comparison could hold because nothing was read at all.
    expect(advertised.gates.hostCapabilities).toContain(MOBILE_WEB_BUNDLE_CAPABILITY)
    expect(advertised.gateStatus).not.toBeNull()
    expect(advertised.probedCapabilities).toContain(MOBILE_WEB_BUNDLE_CAPABILITY)
    expect(advertised.quickCommandsSupported).toBe(true)
    expect(advertised.worktreeCreateSupport.tasksSupported).toBe(true)
    expect(advertised.worktreeCreateSupport.worktreeCreateIdempotency).not.toBe(false)
    expect(oldDesktop.gates.hostCapabilities).not.toContain(MOBILE_WEB_BUNDLE_CAPABILITY)

    expect(asIfNeverAdvertised(advertised)).toEqual(oldDesktop)
  })
})
