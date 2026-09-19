import { describe, expect, it, vi } from 'vitest'
import {
  PTY_OWNERSHIP_BRIDGE_DEFAULT_INPUT_IDS,
  PTY_OWNERSHIP_BRIDGE_DEFAULT_REPLAY_BYTES,
  PTY_OWNERSHIP_BRIDGE_PROTOCOL_VERSION
} from '../../shared/pty-ownership-bridge-contract'
import { SshPtyProvider } from './ssh-pty-provider'

function providerWithCapabilityResponse(response: unknown): SshPtyProvider {
  return new SshPtyProvider('connection-1', {
    request: vi.fn().mockResolvedValue(response),
    notify: vi.fn(),
    onNotification: vi.fn()
  } as never)
}

describe('SSH PTY ownership bridge capability probe', () => {
  it('accepts the additive capability response from a new relay', async () => {
    const provider = providerWithCapabilityResponse({
      protocolVersions: [PTY_OWNERSHIP_BRIDGE_PROTOCOL_VERSION],
      maxReplayBytes: PTY_OWNERSHIP_BRIDGE_DEFAULT_REPLAY_BYTES,
      maxInputIds: PTY_OWNERSHIP_BRIDGE_DEFAULT_INPUT_IDS,
      inputDeduplication: true,
      rollback: true,
      liveTransfer: false,
      statusQuery: true,
      destinationOutput: true,
      postCommitReplay: true,
      reconnectRekey: true
    })

    await expect(provider.getOwnershipBridgeCapabilities()).resolves.toMatchObject({
      protocolVersions: [1],
      inputDeduplication: true,
      rollback: true,
      liveTransfer: false,
      statusQuery: true,
      destinationOutput: true,
      postCommitReplay: true,
      reconnectRekey: true
    })
  })

  it('treats missing or malformed responses as unsupported mixed-version peers', async () => {
    await expect(
      providerWithCapabilityResponse(undefined).getOwnershipBridgeCapabilities()
    ).resolves.toBeNull()
    await expect(
      providerWithCapabilityResponse({
        protocolVersions: [],
        maxReplayBytes: PTY_OWNERSHIP_BRIDGE_DEFAULT_REPLAY_BYTES,
        maxInputIds: PTY_OWNERSHIP_BRIDGE_DEFAULT_INPUT_IDS,
        inputDeduplication: true,
        rollback: true,
        liveTransfer: true
      }).getOwnershipBridgeCapabilities()
    ).resolves.toBeNull()
    await expect(
      providerWithCapabilityResponse({
        protocolVersions: [1],
        maxReplayBytes: 1
      }).getOwnershipBridgeCapabilities()
    ).resolves.toBeNull()
    await expect(
      providerWithCapabilityResponse(new Error('method not found')).getOwnershipBridgeCapabilities()
    ).resolves.toBeNull()
  })
})
