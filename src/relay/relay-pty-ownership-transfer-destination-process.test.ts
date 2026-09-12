import { expect, it, vi } from 'vitest'
import {
  context,
  identity,
  preparation,
  request,
  makeDelegatedRelay
} from './relay-pty-ownership-transfer-delegation-test-fixture'
import type { MethodHandler, RelayDispatcher } from './dispatcher'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_PROCESS_METHOD as method } from '../shared/pty-ownership-transfer-destination-process'
import type { HostProcessInspection } from '../shared/terminal-process-inspection'

const observation: HostProcessInspection = {
  foregroundProcess: null,
  hasChildProcesses: false,
  childProcessEvidence: 'unverifiable',
  foregroundProcessEvidence: {
    authorityGeneration: 'host',
    observationEpoch: 1,
    capturedAgeMs: 0,
    ptyId: identity.terminalId,
    ptyIncarnationId: identity.incarnationId,
    verdict: 'unverifiable',
    reason: 'probe_unavailable'
  }
}
function setup(enabled = true) {
  const inspect = vi.fn(async (_identity: unknown, _authorized: () => boolean) => observation)
  const adapter = makeDelegatedRelay(
    { loadAll: () => [], save: () => {}, remove: () => {} },
    {
      enableDestinationDelegationClaims: enabled,
      resolveTerminalIncarnation: () => identity.incarnationId,
      inspectDestinationProcess: inspect
    }
  )
  adapter.prepare(preparation)
  const handlers = new Map<string, MethodHandler>()
  adapter.register({
    onRequest: (name: string, handler: MethodHandler) => handlers.set(name, handler)
  } as unknown as RelayDispatcher)
  const read = (ctx = context()) =>
    handlers.get(method)!(
      { ...request(), destinationClaim: { generation: 1, claimId: 'claim-1' } },
      ctx
    )
  return { adapter, inspect, handlers, read }
}

it('keeps process inspection behind the claim gate', () => {
  expect(setup(false).handlers.has(method)).toBe(false)
})

it('refuses unclaimed and wrong-connection inspections before probing', async () => {
  const f = setup()
  await expect(f.read()).rejects.toThrow('inspection_unverifiable')
  f.adapter.claimDestination(request(), context())
  await expect(f.read(context(3))).rejects.toThrow('inspection_unverifiable')
  expect(f.inspect).not.toHaveBeenCalled()
})

it('preserves unavailable host evidence without exposing the credential', async () => {
  const f = setup()
  f.adapter.claimDestination(request(), context())
  const result = await f.read()
  expect(result).toMatchObject({
    foregroundProcessEvidence: { verdict: 'unverifiable' },
    childProcessEvidence: 'unverifiable'
  })
  expect(result).not.toHaveProperty('credential')
  expect(result).not.toHaveProperty('hasChildProcesses')
})

it('discards a host answer if another destination claims during the probe', async () => {
  const f = setup()
  f.adapter.claimDestination(request(), context())
  f.inspect.mockImplementation(async (_identity, authorized) => {
    expect(authorized()).toBe(true)
    f.adapter.claimDestination(request(2), context(3))
    expect(authorized()).toBe(false)
    return observation
  })
  await expect(f.read()).rejects.toThrow('inspection_unverifiable')
})
