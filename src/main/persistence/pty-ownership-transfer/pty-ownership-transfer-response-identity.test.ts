import { expect, it } from 'vitest'
import { assertTransferIdentity } from './pty-ownership-transfer-response-identity'

const identity = {
  bridgeId: 'bridge-1',
  terminalId: 'terminal-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 1,
  destinationRuntimeId: 'runtime-1'
} as const

it('accepts an exact transfer identity with additive response fields', () => {
  const response = { ...identity, phase: 'published' }
  expect(() => assertTransferIdentity(response, identity)).not.toThrow()
})

it.each([
  { bridgeId: 'bridge-2' },
  { terminalId: 'terminal-2' },
  { incarnationId: 'incarnation-2' },
  { ownerLease: 'lease-2' },
  { sourceOwnerGeneration: 2 },
  { destinationRuntimeId: 'runtime-2' }
])('rejects a changed transfer response identity %j', (changed) => {
  expect(() => assertTransferIdentity({ ...identity, ...changed }, identity)).toThrow(
    'pty_ownership_transfer_response_identity_mismatch'
  )
})
