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
import { stubRpcClient } from './rpc-client-test-stub'

const recordHostAppVersionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('./host-app-version-store', () => ({
  recordHostAppVersion: (...args: unknown[]) => recordHostAppVersionMock(...args)
}))

// Stub durable descriptor recording; this suite observes only hook state.
vi.mock('./host-descriptor-recorder', () => ({
  recordHostDescriptorFromStatus: vi.fn()
}))

// Surround the new capability with real entries so head/tail truncation cannot satisfy the comparison.
const ADVERTISED_CAPABILITIES = [
  'files.pathsExist',
  MOBILE_AI_VAULT_CAPABILITY,
  'mobile.tasks.v1',
  MOBILE_WEB_BUNDLE_CAPABILITY,
  'worktree.create-idempotency.v1',
  'terminal.quick-commands.v1'
] as const

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

function clientAnswering(reply: RpcResponse): RpcClient {
  return stubRpcClient({ sendRequest: vi.fn().mockResolvedValue(reply) })
}

async function renderGates(client: RpcClient): Promise<HostStatusGates> {
  // Use a holder for callback-written values so control-flow narrowing does not freeze them at their initializer.
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
  worktreeCreateSupport: NewWorktreeRuntimeCapabilities | null
}

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
  // Derive both sides from one list so new advertised strings must leave all other visible outcomes unchanged.
  // Presence assertions also catch closed enums that drop the entire salvaged capability field.
  it('changes nothing a released client reads apart from the capability string itself', async () => {
    const advertised = await readEverything(ADVERTISED_CAPABILITIES)
    const oldDesktop = await readEverything(OLD_DESKTOP_CAPABILITIES)

    // Prove the read happened before comparing otherwise-empty outcomes.
    expect(advertised.gates.hostCapabilities).toContain(MOBILE_WEB_BUNDLE_CAPABILITY)
    expect(advertised.gateStatus).not.toBeNull()
    expect(advertised.probedCapabilities).toContain(MOBILE_WEB_BUNDLE_CAPABILITY)
    expect(advertised.quickCommandsSupported).toBe(true)
    expect(advertised.worktreeCreateSupport?.tasksSupported).toBe(true)
    expect(advertised.worktreeCreateSupport?.worktreeCreateIdempotency).toEqual({
      dedupeTtlMs: 60_000
    })
    expect(oldDesktop.gates.hostCapabilities).not.toContain(MOBILE_WEB_BUNDLE_CAPABILITY)

    expect(asIfNeverAdvertised(advertised)).toEqual(oldDesktop)
  })
})
