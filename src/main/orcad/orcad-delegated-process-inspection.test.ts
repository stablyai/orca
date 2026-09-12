import { expect, it } from 'vitest'
import { setupDelegatedPtyOperations } from './orcad-delegated-pty-operations-fixture'
import { identity } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

const evidence = {
  authorityGeneration: 'host-epoch',
  observationEpoch: 1,
  capturedAgeMs: 0,
  ptyId: identity.terminalId,
  ptyIncarnationId: identity.incarnationId,
  verdict: 'live',
  processName: 'bash',
  fence: {
    platform: 'posix',
    shellPid: 42,
    shellStartTime: 'start',
    tty: 'pts/1',
    foregroundPgid: 42
  }
}
const reply = {
  ...identity,
  version: 1,
  destinationClaim: { generation: 1, claimId: 'claim' },
  foregroundProcessEvidence: evidence,
  childProcessEvidence: 'no-children'
}

it('returns fenced host evidence without borrowing legacy booleans', async () => {
  const f = setupDelegatedPtyOperations()
  f.transport.mockResolvedValueOnce({ ...reply, hasChildProcesses: true } as never)
  const result = await f.operations.inspectProcess(identity.terminalId)
  expect(result.childProcessEvidence).toBe('no-children')
  expect(result.foregroundProcessEvidence).toEqual(evidence)
  expect(result).not.toHaveProperty('hasChildProcesses')
})

it('preserves unverifiable host evidence', async () => {
  const f = setupDelegatedPtyOperations()
  f.transport.mockResolvedValueOnce({
    ...reply,
    foregroundProcessEvidence: {
      ...evidence,
      verdict: 'unverifiable',
      reason: 'probe_unavailable'
    },
    childProcessEvidence: 'unverifiable'
  } as never)
  await expect(f.operations.inspectProcess(identity.terminalId)).resolves.toMatchObject({
    foregroundProcessEvidence: { verdict: 'unverifiable' },
    childProcessEvidence: 'unverifiable'
  })
})

it.each([
  { destinationClaim: { generation: 2, claimId: 'claim' } },
  { terminalId: 'wrong' },
  { foregroundProcessEvidence: undefined },
  { foregroundProcessEvidence: { ...evidence, ptyIncarnationId: 'wrong' } },
  { foregroundProcessEvidence: { ...evidence, verdict: 'exited', reason: 'exit' } },
  { childProcessEvidence: undefined },
  { childProcessEvidence: false }
])('rejects unfenced or malformed process evidence %#', async (patch) => {
  const f = setupDelegatedPtyOperations()
  f.transport.mockResolvedValueOnce({ ...reply, ...patch } as never)
  await expect(f.operations.inspectProcess(identity.terminalId)).rejects.toThrow()
})

it('rejects an observation after local authority is lost', async () => {
  const f = setupDelegatedPtyOperations()
  f.transport.mockImplementationOnce(async () => {
    f.isActive.mockReturnValue(false)
    return reply as never
  })
  await expect(f.operations.inspectProcess(identity.terminalId)).rejects.toThrow(
    'authority_unverifiable'
  )
})
