import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PTY_OWNERSHIP_TRANSFER_METHODS } from '../shared/pty-ownership-transfer-wire'
import { RelayDispatcher, type MethodHandler } from './dispatcher'
import { RelayRuntimeServices } from './relay-runtime-services'
import { PTY_OWNERSHIP_CAPTURE_METHODS } from '../shared/pty-ownership-capture-wire'
import { PTY_OWNERSHIP_CAPTURE_IMPORT_ACK_METHOD } from '../shared/pty-ownership-capture-import-receipt'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_COMMIT_METHOD } from '../shared/pty-ownership-transfer-destination-claim'
import { PTY_OWNERSHIP_TRANSFER_SOURCE_RETIREMENT_METHOD } from '../shared/pty-ownership-transfer-source-retirement'

function createRuntime(
  enableOwnershipTransferMutation?: boolean,
  ownershipTransferStoreDirectory?: string,
  enableDelegatedOwnershipCapture?: boolean,
  enableSourceDeliveryRetirement?: boolean
) {
  const dispatcher = new RelayDispatcher(vi.fn(() => true))
  const options =
    enableOwnershipTransferMutation === undefined && ownershipTransferStoreDirectory === undefined
      ? {}
      : {
          ...(enableOwnershipTransferMutation === undefined
            ? {}
            : { enableOwnershipTransferMutation }),
          ...(ownershipTransferStoreDirectory === undefined
            ? {}
            : { ownershipTransferStoreDirectory })
        }
  const runtime = new RelayRuntimeServices(dispatcher, 1_000, 'test-version', {
    ...options,
    enableDelegatedOwnershipCapture,
    enableSourceDeliveryRetirement
  })
  const requestHandlers = (dispatcher as unknown as { requestHandlers: Map<string, MethodHandler> })
    .requestHandlers
  return { dispatcher, requestHandlers, runtime }
}

async function ownershipCapabilities(requestHandlers: Map<string, MethodHandler>) {
  const handler = requestHandlers.get('pty.getOwnershipBridgeCapabilities')
  if (!handler) {
    throw new Error('ownership-transfer capability handler was not registered')
  }
  return handler({}, { clientId: 1, isStale: () => false })
}

describe('RelayRuntimeServices ownership-transfer mutation gate', () => {
  it.each(Array.from({ length: 16 }, (_, mask) => mask))(
    'requires mutation, storage, delegation and retirement opt-ins (mask %s)',
    async (mask) => {
      const directory = mkdtempSync(join(tmpdir(), 'orca-retirement-gate-'))
      const { dispatcher, requestHandlers, runtime } = createRuntime(
        (mask & 1) !== 0,
        (mask & 2) !== 0 ? directory : undefined,
        (mask & 4) !== 0,
        (mask & 8) !== 0
      )
      try {
        expect(requestHandlers.has(PTY_OWNERSHIP_TRANSFER_SOURCE_RETIREMENT_METHOD)).toBe(
          mask === 15
        )
        const capabilities = await ownershipCapabilities(requestHandlers)
        for (const key of [
          'sourceRetirementVersion',
          'sourceRetirementBoundaryVersion',
          'sourceRetirementRecoveryVersion'
        ]) {
          if (mask === 15) {
            expect(capabilities).toHaveProperty(key, 1)
          } else {
            expect(capabilities).not.toHaveProperty(key)
          }
        }
        runtime.disposeHandlers()
        expect(await ownershipCapabilities(requestHandlers)).not.toHaveProperty(
          'sourceRetirementVersion'
        )
      } finally {
        runtime.disposeHandlers()
        dispatcher.dispose()
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )
  it.each([
    [true, true, true],
    [false, true, true],
    [true, false, true],
    [true, true, false]
  ])(
    'gates delegated capture on mutation=%s, storage=%s, delegation=%s',
    async (mutation, storage, delegation) => {
      const directory = mkdtempSync(join(tmpdir(), 'orca-delegated-gate-'))
      const { dispatcher, requestHandlers, runtime } = createRuntime(
        mutation,
        storage ? directory : undefined,
        delegation
      )
      const enabled = mutation && storage && delegation
      try {
        const capabilities = await ownershipCapabilities(requestHandlers)
        for (const field of [
          'destinationDelegationVersion',
          'captureBoundaryVersion',
          'captureSelectionVersion'
        ]) {
          if (enabled) {
            expect(capabilities).toHaveProperty(field, 1)
          } else {
            expect(capabilities).not.toHaveProperty(field)
          }
        }
        for (const method of [
          ...Object.values(PTY_OWNERSHIP_CAPTURE_METHODS),
          PTY_OWNERSHIP_CAPTURE_IMPORT_ACK_METHOD,
          PTY_OWNERSHIP_TRANSFER_DESTINATION_COMMIT_METHOD
        ]) {
          expect(requestHandlers.has(method), method).toBe(enabled)
        }
        runtime.disposeHandlers()
        const disposed = await ownershipCapabilities(requestHandlers)
        expect(disposed).not.toHaveProperty('destinationDelegationVersion')
        expect(disposed).not.toHaveProperty('captureBoundaryVersion')
      } finally {
        runtime.disposeHandlers()
        dispatcher.dispose()
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )
  it('defaults to status-only registration and disabled mutation capabilities', async () => {
    const { dispatcher, requestHandlers, runtime } = createRuntime()
    try {
      await expect(ownershipCapabilities(requestHandlers)).resolves.toMatchObject({
        liveTransfer: false,
        destinationOutput: false,
        destinationControl: false,
        authoritativeExit: false,
        postCommitReplay: false,
        reconnectRekey: false
      })
      expect(requestHandlers.has(PTY_OWNERSHIP_TRANSFER_METHODS.status)).toBe(true)
      expect(requestHandlers.has(PTY_OWNERSHIP_TRANSFER_METHODS.prepare)).toBe(false)
    } finally {
      runtime.disposeHandlers()
      dispatcher.dispose()
    }
  })

  it('keeps mutation disabled when the explicit opt-in lacks a durable store', async () => {
    const { dispatcher, requestHandlers, runtime } = createRuntime(true)
    try {
      await expect(ownershipCapabilities(requestHandlers)).resolves.toMatchObject({
        liveTransfer: false,
        destinationOutput: false,
        destinationControl: false,
        authoritativeExit: false,
        postCommitReplay: false,
        reconnectRekey: false
      })
      expect(requestHandlers.has(PTY_OWNERSHIP_TRANSFER_METHODS.status)).toBe(true)
      expect(requestHandlers.has(PTY_OWNERSHIP_TRANSFER_METHODS.prepare)).toBe(false)
    } finally {
      runtime.disposeHandlers()
      dispatcher.dispose()
    }
  })

  it('registers mutation routes only for an explicit opt-in with a durable store', async () => {
    const storeDirectory = mkdtempSync(join(tmpdir(), 'orca-relay-transfer-store-'))
    const { dispatcher, requestHandlers, runtime } = createRuntime(true, storeDirectory)
    try {
      await expect(ownershipCapabilities(requestHandlers)).resolves.toMatchObject({
        liveTransfer: true,
        destinationOutput: true,
        destinationControl: true,
        authoritativeExit: true,
        postCommitReplay: true,
        reconnectRekey: true
      })
      expect(requestHandlers.has(PTY_OWNERSHIP_TRANSFER_METHODS.status)).toBe(true)
      expect(requestHandlers.has(PTY_OWNERSHIP_TRANSFER_METHODS.prepare)).toBe(true)
    } finally {
      runtime.disposeHandlers()
      dispatcher.dispose()
      rmSync(storeDirectory, { recursive: true, force: true })
    }
  })

  it('keeps ordinary relay startup alive when a dormant journal is malformed and mutation is off', () => {
    const storeDirectory = mkdtempSync(join(tmpdir(), 'orca-relay-transfer-store-'))
    writeFileSync(join(storeDirectory, `${'a'.repeat(64)}.json`), '{not-json\n', 'utf8')
    let runtime: RelayRuntimeServices | undefined
    let dispatcher: RelayDispatcher | undefined
    try {
      dispatcher = new RelayDispatcher(vi.fn(() => true))
      runtime = new RelayRuntimeServices(dispatcher, 1_000, 'test-version', {
        ownershipTransferStoreDirectory: storeDirectory
      })
      const requestHandlers = (
        dispatcher as unknown as { requestHandlers: Map<string, MethodHandler> }
      ).requestHandlers
      expect(requestHandlers.has(PTY_OWNERSHIP_TRANSFER_METHODS.status)).toBe(true)
      expect(requestHandlers.has(PTY_OWNERSHIP_TRANSFER_METHODS.prepare)).toBe(false)
    } finally {
      runtime?.disposeHandlers()
      dispatcher?.dispose()
      rmSync(storeDirectory, { recursive: true, force: true })
    }
  })
})
