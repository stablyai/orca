import { expect, it, vi } from 'vitest'
import { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import type { OmpSessionOwningRpcClient } from '../../shared/omp-rpc-protocol'
import { createEphemeralAgentSessionClaimSigner } from '../runtime/agent-session-claim-identity'
import { OMP_RPC_LOCAL_NAMESPACE, OMP_RPC_LOCAL_WORKTREE_SCOPE } from './omp-rpc-local-claim-scope'
import { OmpRpcLocalSessionWriteFence } from './omp-rpc-local-session-write-fence'
import { OmpRpcSessionOwner, type OmpRpcOwnedSession } from './omp-rpc-session-owner'
import { OmpRpcChatSessionReadbackReconciler } from './omp-rpc-chat-session-readback-reconciler'

it('keeps the switched-session claim and fence queued until the retired child exits', async () => {
  let resolveExit!: () => void
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve
  })
  const client = {
    dispose: vi.fn(),
    whenExited: () => exited
  } as unknown as OmpSessionOwningRpcClient
  const registry = new ClaimedAgentPtyOwnerRegistry()
  const signer = createEphemeralAgentSessionClaimSigner('readback-race')
  const claimA = signer.createClaim({
    namespace: OMP_RPC_LOCAL_NAMESPACE,
    identity: { agent: 'omp', providerSession: { key: 'session_id', id: 'session-a' } },
    canonicalWorktreeId: OMP_RPC_LOCAL_WORKTREE_SCOPE
  })
  const initial = await registry.ensureRpc({ claim: claimA, spawn: () => client })
  const owned: OmpRpcOwnedSession = { client, owner: initial.owner }
  const session = {
    owned,
    emitRetirement: vi.fn(),
    dispose: vi.fn()
  }
  const writerFence = new OmpRpcLocalSessionWriteFence()
  const rpcFenceOwner = 'rpc-pane:1'
  expect(writerFence.reserve('/sessions/a.jsonl', rpcFenceOwner)).toBe(true)
  expect(writerFence.reserve('/sessions/b.jsonl', 'pty-pane:1')).toBe(true)
  const sessionsByPaneKey = new Map([['pane', session]])
  const writerFencesByPaneKey = new Map([
    ['pane', { path: '/sessions/a.jsonl', owner: rpcFenceOwner }]
  ])
  const owner = new OmpRpcSessionOwner({
    registry,
    proveRpcExit: async () => ({ status: 'unverifiable', reason: 'child exit pending' })
  })
  const reconciler = new OmpRpcChatSessionReadbackReconciler({
    generationByPaneKey: new Map([['pane', 1]]),
    sessionsByPaneKey: sessionsByPaneKey as never,
    claimsByPaneKey: new Map([['pane', claimA]]),
    sessionFilePathsByPaneKey: new Map([['pane', '/sessions/a.jsonl']]),
    sessionIdsByPaneKey: new Map([['pane', 'session-a']]),
    writerFencesByPaneKey,
    handbackOwedPaneKeys: new Set(),
    writerFence,
    ptyOwnerRegistry: registry,
    claimSigner: signer,
    owner,
    claimedSessionFilePathsExcluding: () => new Set()
  })

  await expect(
    reconciler.reconcile(
      { paneKey: 'pane', ptyId: 'pty-a', hasOtherPtySessionWriter: async () => false },
      1,
      session as never,
      { kind: 'identity', sessionFilePath: '/sessions/b.jsonl', sessionId: 'session-b' }
    )
  ).rejects.toThrow('agent_session_conflict')

  expect(registry.findRpc(owned.owner.claim)).not.toBeNull()
  writerFence.release('/sessions/b.jsonl', 'pty-pane:1')
  expect(writerFence.reserve('/sessions/b.jsonl', 'third-pane:1')).toBe(false)

  resolveExit()
  await Promise.resolve()
  await Promise.resolve()
  expect(writerFence.reserve('/sessions/b.jsonl', 'third-pane:1')).toBe(true)
})
