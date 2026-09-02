import { describe, expect, it } from 'vitest'
import { parseRemoteFederatedWorkerStartReceipt } from './orchestration-federated-attach-receipt'

describe('remote federated worker start receipt', () => {
  it.each([
    { name: 'missing runtime epoch', receipt: {} },
    { name: 'non-string runtime epoch', receipt: { runtimeEpoch: 42 } },
    { name: 'missing worktree id', receipt: { runtimeEpoch: 'epoch_remote' } },
    {
      name: 'missing terminal handle',
      receipt: {
        runtimeEpoch: 'epoch_remote',
        worktreeId: 'worktree_remote',
        terminalHandle: undefined
      }
    }
  ])('rejects a ready receipt with $name', ({ receipt }) => {
    expect(() =>
      parseRemoteFederatedWorkerStartReceipt({
        dispatchId: 'ctx_remote',
        state: 'ready',
        terminalHandle: 'term_remote',
        ...receipt
      })
    ).toThrow('invalid ready receipt')
  })

  it('accepts a non-ready receipt without ready-only resources', () => {
    expect(
      parseRemoteFederatedWorkerStartReceipt({
        dispatchId: 'ctx_remote',
        state: 'outcome_unknown'
      })
    ).toMatchObject({ dispatchId: 'ctx_remote', state: 'outcome_unknown' })
  })
})
