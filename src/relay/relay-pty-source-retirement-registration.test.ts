import { expect, it, vi } from 'vitest'
import {
  context,
  request,
  preparation,
  makeDelegatedRelay
} from './relay-pty-ownership-transfer-delegation-test-fixture'
import type { RelayPtyOwnershipTransferDurableRecord } from './relay-pty-ownership-transfer-adapter-contract'
import type { RelayDispatcher, MethodHandler } from './dispatcher'
import { PTY_OWNERSHIP_TRANSFER_SOURCE_RETIREMENT_METHOD as RETIRE } from '../shared/pty-ownership-transfer-source-retirement'
import { parsePtyOwnershipTransferDestinationStatus } from '../shared/pty-ownership-transfer-destination-status'

it.each([
  [false, false, false],
  [false, true, true],
  [true, false, true],
  [true, true, false],
  [true, true, true]
] as const)(
  'keeps handler/capability aligned for gate=%s factory=%s commit=%s',
  (enabled, factory, commit) => {
    let records: RelayPtyOwnershipTransferDurableRecord[] = []
    const prepare = vi.fn(() => {
      throw new Error('must not prepare')
    })
    const adapter = makeDelegatedRelay(
      {
        loadAll: () => records,
        save: (record) => {
          records = [structuredClone(record)]
        },
        remove: vi.fn()
      },
      {
        enableSourceDeliveryRetirement: enabled,
        enableDestinationDelegationCommit: commit,
        ...(factory ? { prepareSourceDeliveryRetirement: prepare } : {})
      }
    )
    adapter.prepare(preparation)
    const handlers = new Map<string, MethodHandler>()
    adapter.register({
      onRequest: (name: string, handler: MethodHandler) => handlers.set(name, handler),
      onLegacyPtyCapacity: () => () => {},
      onClientDetached: () => () => {},
      onDisposed: () => () => {}
    } as unknown as RelayDispatcher)
    const status = adapter.inspectDestination(request(), context())
    const available = enabled && factory && commit
    expect(handlers.has(RETIRE)).toBe(available)
    expect(parsePtyOwnershipTransferDestinationStatus(status).sourceRetirementVersion).toBe(
      available ? 1 : undefined
    )
    expect(prepare).not.toHaveBeenCalled()
    const { sourceRetirementVersion: _capability, ...legacyStatus } = status
    expect(
      parsePtyOwnershipTransferDestinationStatus(legacyStatus).sourceRetirementVersion
    ).toBeUndefined()
  }
)
