import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { IPtyProvider } from '../../../providers/types'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { parseSshRelayResetIntent } from '../../../ssh/ssh-relay-reset-intent'
import {
  parseSshRelayResetPreparationReceipt,
  sshRelayResetRecordDigest
} from '../../../ssh/ssh-relay-reset-retirement-record'
import { captureSshResetRetirementSelection } from './ssh-reset-selection-capture'
import { retireSshResetRoutes } from './ssh-reset-route-retirement'
import { ptyOwnership, ptyIncarnationById, setPtyOwnership } from './ownership-state'
import { sshProviders, sshProvidersByGeneration } from './registry'
import { ptySizes, visibleRendererPtys } from '../delivery/visibility-state'
import { ptyPaneKey, paneKeyPtyId, registerPaneKeyTeardownListener } from '../pane/key-state'

it('clears real ancillary state while refusing route recreation and preserving unrelated state', () => {
  const targetId = randomUUID()
  const id = toAppSshPtyId(targetId, 'selected')
  const other = toAppSshPtyId(randomUUID(), 'other')
  const paneKey = randomUUID()
  const providerGeneration = 1234567
  const provider = { providerGeneration } as unknown as IPtyProvider
  const intent = parseSshRelayResetIntent({
    version: 1,
    targetId,
    targetGeneration: 1,
    targetRoutingDigest: 'a'.repeat(64),
    clientInstanceId: 'desktop',
    serverBuildId: 'build',
    endpoint: {
      relayDir: '/relay',
      runtimePath: '/relay/bun',
      runtimeKind: 'bun',
      sockPath: '/relay/socket',
      credentialFile: '/relay/credential',
      relayPlatform: 'linux-x64'
    },
    request: {
      version: 1,
      operationId: 'reset',
      runtimeIncarnation: 'daemon',
      ownerGeneration: 1,
      ownerLease: 'lease'
    }
  })
  sshProviders.set(targetId, provider)
  sshProvidersByGeneration.set(providerGeneration, provider)
  ptyOwnership.set(id, targetId)
  ptyIncarnationById.set(id, randomUUID())
  ptySizes.set(id, { cols: 80, rows: 24 })
  ptySizes.set(other, { cols: 90, rows: 30 })
  visibleRendererPtys.add(id)
  ptyPaneKey.set(id, paneKey)
  paneKeyPtyId.set(paneKey, id)
  const recreate = vi.fn(() => {
    try {
      setPtyOwnership(id, targetId)
      return 'admitted'
    } catch (error) {
      return String(error)
    }
  })
  const callback = vi.fn((key: string) => {
    if (key === paneKey) {
      recreate()
    }
  })
  const unsubscribe = registerPaneKeyTeardownListener(callback)
  try {
    const assertAuthority = vi.fn()
    const { selection, assertCurrent } = captureSshResetRetirementSelection({
      intent,
      expectedProvider: provider,
      readLeases: () => [],
      assertAuthority,
      retiredAt: 100
    })
    assertCurrent()
    const receipt = parseSshRelayResetPreparationReceipt(
      {
        version: 1,
        intentSha256: selection.intentSha256,
        selectionSha256: sshRelayResetRecordDigest(selection),
        acknowledgment: {
          version: 1,
          operationId: 'reset',
          runtimeIncarnation: 'daemon',
          prepared: true
        }
      },
      intent,
      selection
    )
    const options = { intent, selection, receipt, expectedProvider: provider, assertAuthority }
    retireSshResetRoutes(options).assertRetired()
    expect(ptySizes.has(id)).toBe(false)
    expect(visibleRendererPtys.has(id)).toBe(false)
    expect(ptyPaneKey.has(id)).toBe(false)
    expect(paneKeyPtyId.has(paneKey)).toBe(false)
    expect(callback).toHaveBeenCalledWith(paneKey)
    expect(recreate).toHaveReturnedWith('Error: ssh_relay_reset_route_retired')
    expect(ptySizes.get(other)).toEqual({ cols: 90, rows: 30 })
    retireSshResetRoutes(options).assertRetired()
    expect(sshProviders.get(targetId)).toBe(provider)
  } finally {
    unsubscribe()
    sshProviders.delete(targetId)
    sshProvidersByGeneration.delete(providerGeneration)
    ptyOwnership.delete(id)
    ptyIncarnationById.delete(id)
    ptySizes.delete(id)
    ptySizes.delete(other)
    visibleRendererPtys.delete(id)
    ptyPaneKey.delete(id)
    paneKeyPtyId.delete(paneKey)
  }
})
