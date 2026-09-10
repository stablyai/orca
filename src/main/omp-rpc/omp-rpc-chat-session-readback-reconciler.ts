import type { AgentSessionExecutionClaim } from '../../shared/agent-session-host-authority'
import type { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import type { AgentSessionClaimSigner } from '../runtime/agent-session-claim-identity'
import type { OmpRpcChatSession, OmpRpcChatSessionIdentityReadback } from './omp-rpc-chat-session'
import type { OmpRpcChatPaneHandbackContext } from './omp-rpc-chat-session-registry'
import { OMP_RPC_LOCAL_NAMESPACE, OMP_RPC_LOCAL_WORKTREE_SCOPE } from './omp-rpc-local-claim-scope'
import type { OmpRpcLocalSessionWriteFence } from './omp-rpc-local-session-write-fence'
import type { OmpRpcSessionOwner } from './omp-rpc-session-owner'
import { transferOmpRpcSwitchedSessionClaim } from './omp-rpc-switched-session-claim'

type WriterFence = { path: string; owner: string }

export type OmpRpcChatSessionReadbackReconcilerDependencies = {
  generationByPaneKey: Map<string, number>
  sessionsByPaneKey: Map<string, OmpRpcChatSession>
  claimsByPaneKey: Map<string, AgentSessionExecutionClaim>
  sessionFilePathsByPaneKey: Map<string, string>
  sessionIdsByPaneKey: Map<string, string>
  writerFencesByPaneKey: Map<string, WriterFence>
  handbackOwedPaneKeys: Set<string>
  writerFence: OmpRpcLocalSessionWriteFence
  ptyOwnerRegistry: ClaimedAgentPtyOwnerRegistry
  claimSigner: AgentSessionClaimSigner
  owner: OmpRpcSessionOwner
  claimedSessionFilePathsExcluding: (paneKey: string) => ReadonlySet<string>
}

export class OmpRpcChatSessionReadbackReconciler {
  constructor(private readonly dependencies: OmpRpcChatSessionReadbackReconcilerDependencies) {}

  async reconcile(
    { paneKey, ptyId, hasOtherPtySessionWriter, onLateRpcChildExit }: OmpRpcChatPaneHandbackContext,
    generation: number,
    session: OmpRpcChatSession,
    readback: OmpRpcChatSessionIdentityReadback
  ): Promise<void> {
    if (
      this.dependencies.generationByPaneKey.get(paneKey) !== generation ||
      this.dependencies.sessionsByPaneKey.get(paneKey) !== session
    ) {
      return
    }
    if (readback.kind === 'unreadable') {
      await this.retire({ paneKey, ptyId, hasOtherPtySessionWriter, onLateRpcChildExit }, session, {
        reason: `omp_rpc_session_identity_unreadable: ${readback.reason}`,
        provenOffSession: false
      })
      return
    }
    let movedClaim = false
    try {
      if (await hasOtherPtySessionWriter?.(readback.sessionFilePath, ptyId)) {
        throw new Error('agent_session_conflict')
      }
      const claim = await transferOmpRpcSwitchedSessionClaim({
        session,
        sessionId: readback.sessionId,
        claimedByAnotherPane: this.dependencies
          .claimedSessionFilePathsExcluding(paneKey)
          .has(readback.sessionFilePath),
        ptyOwnerRegistry: this.dependencies.ptyOwnerRegistry,
        claimSigner: this.dependencies.claimSigner,
        namespace: OMP_RPC_LOCAL_NAMESPACE,
        canonicalWorktreeId: OMP_RPC_LOCAL_WORKTREE_SCOPE
      })
      movedClaim = true
      const previousWriterFence = this.dependencies.writerFencesByPaneKey.get(paneKey)
      if (
        !previousWriterFence ||
        !this.dependencies.writerFence.move(
          previousWriterFence.path,
          readback.sessionFilePath,
          previousWriterFence.owner
        )
      ) {
        if (
          previousWriterFence &&
          this.dependencies.writerFence.reserveAfterCurrentWriter(
            readback.sessionFilePath,
            previousWriterFence.owner
          )
        ) {
          this.dependencies.writerFence.release(previousWriterFence.path, previousWriterFence.owner)
          this.dependencies.sessionFilePathsByPaneKey.set(paneKey, readback.sessionFilePath)
          this.dependencies.sessionIdsByPaneKey.set(paneKey, readback.sessionId)
          this.dependencies.writerFencesByPaneKey.set(paneKey, {
            path: readback.sessionFilePath,
            owner: previousWriterFence.owner
          })
        }
        throw new Error('agent_session_conflict')
      }
      this.dependencies.claimsByPaneKey.set(paneKey, claim)
      this.dependencies.sessionFilePathsByPaneKey.set(paneKey, readback.sessionFilePath)
      this.dependencies.sessionIdsByPaneKey.set(paneKey, readback.sessionId)
      this.dependencies.writerFencesByPaneKey.set(paneKey, {
        path: readback.sessionFilePath,
        owner: previousWriterFence.owner
      })
    } catch (error) {
      await this.retire({ paneKey, ptyId, hasOtherPtySessionWriter, onLateRpcChildExit }, session, {
        reason: error instanceof Error ? error.message : String(error),
        provenOffSession: !movedClaim
      })
      throw error
    }
  }

  private async retire(
    { paneKey, onLateRpcChildExit }: OmpRpcChatPaneHandbackContext,
    session: OmpRpcChatSession,
    options: { reason: string; provenOffSession: boolean }
  ): Promise<void> {
    const freed = await this.dependencies.owner.disposeAndReleaseClaim(
      session.owned,
      options.provenOffSession,
      () => this.oweHandbackAfterProvenExit(paneKey, onLateRpcChildExit)
    )
    if (this.dependencies.sessionsByPaneKey.get(paneKey) === session) {
      this.dependencies.sessionsByPaneKey.delete(paneKey)
      this.dependencies.claimsByPaneKey.delete(paneKey)
      this.dependencies.sessionIdsByPaneKey.delete(paneKey)
      if (freed) {
        this.dependencies.sessionFilePathsByPaneKey.delete(paneKey)
        const writerFence = this.dependencies.writerFencesByPaneKey.get(paneKey)
        if (writerFence) {
          this.dependencies.writerFence.release(writerFence.path, writerFence.owner)
          this.dependencies.writerFencesByPaneKey.delete(paneKey)
        }
        this.dependencies.handbackOwedPaneKeys.add(paneKey)
      }
    }
    session.emitRetirement(options.reason)
    session.dispose()
  }

  oweHandbackAfterProvenExit(paneKey: string, notify?: () => void): void {
    if (this.dependencies.sessionsByPaneKey.has(paneKey)) {
      return
    }
    this.dependencies.sessionFilePathsByPaneKey.delete(paneKey)
    const writerFence = this.dependencies.writerFencesByPaneKey.get(paneKey)
    if (writerFence) {
      this.dependencies.writerFence.release(writerFence.path, writerFence.owner)
      this.dependencies.writerFencesByPaneKey.delete(paneKey)
    }
    this.dependencies.sessionIdsByPaneKey.delete(paneKey)
    this.dependencies.handbackOwedPaneKeys.add(paneKey)
    notify?.()
  }
}
