import { expect, it } from 'vitest'
import { setupDelegatedPtyOperations } from './orcad-delegated-pty-operations-fixture'
import { identity } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_CWD_METHOD } from '../../shared/pty-ownership-transfer-destination-cwd'

const reply = {
  ...identity,
  version: 1,
  destinationClaim: { generation: 1, claimId: 'claim' },
  cwd: '/srv/current'
}
it.each(['/srv/current', null])('returns measured cwd %s through the connection', async (cwd) => {
  const f = setupDelegatedPtyOperations()
  f.transport.mockResolvedValueOnce({ ...reply, cwd } as never)
  await expect(f.operations.inspectCwd(identity.terminalId)).resolves.toBe(cwd)
  expect(f.transport).toHaveBeenCalledWith(
    PTY_OWNERSHIP_TRANSFER_DESTINATION_CWD_METHOD,
    expect.objectContaining({ destinationClaim: reply.destinationClaim })
  )
})

it.each([
  { terminalId: 'wrong' },
  { destinationClaim: { generation: 2, claimId: 'claim' } },
  { destinationClaim: { generation: 1, claimId: 'wrong' } },
  { cwd: undefined },
  { cwd: '' },
  { cwd: 'bad\0path' }
])('refuses mismatched or malformed evidence %#', async (patch) => {
  const f = setupDelegatedPtyOperations()
  f.transport.mockResolvedValueOnce({ ...reply, ...patch } as never)
  await expect(f.operations.inspectCwd(identity.terminalId)).rejects.toThrow()
})

it('preserves old-host method-not-found without a fallback', async () => {
  const f = setupDelegatedPtyOperations()
  f.transport.mockRejectedValueOnce(new Error('method_not_found'))
  await expect(f.operations.inspectCwd(identity.terminalId)).rejects.toThrow('method_not_found')
  expect(f.transport).toHaveBeenCalledTimes(1)
})

it('discards evidence after local connection authority changes', async () => {
  const f = setupDelegatedPtyOperations()
  f.transport.mockImplementationOnce(async () => {
    f.isActive.mockReturnValue(false)
    return reply as never
  })
  await expect(f.operations.inspectCwd(identity.terminalId)).rejects.toThrow(
    'authority_unverifiable'
  )
})
