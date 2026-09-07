// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithStructuredAgentSessionReproveTuiOwner } from './orca-runtime-structured-agent-session-reprove-tui-owner'
import { join } from 'node:path'
import { codexProviderHandleLink } from '../codex/codex-structured-owner-identity'
import { claudeProviderHandleLink } from '../claude/claude-structured-owner-identity'
import type { AgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import {
  resolveTerminalSessionWorktreeId,
  runtimeWorktreeIdsEqual
} from './runtime-worktree-path-identity'
import { canonicalizeAgentSessionIdentity } from './agent-session-claim-identity'
import { makePaneKey } from '../../shared/stable-pane-id'
import { evaluateStructuredTuiRecoveryClaim } from './structured-tui-recovery-claim-match'
import {
  cloneAgentSessionOwnerBinding,
  scopedAgentSessionClaimsEqual
} from '../../shared/claimed-agent-pty-owner-snapshot'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'

export class OrcaRuntimeWithStructuredAgentSessionRecoverTuiOwner extends OrcaRuntimeWithStructuredAgentSessionReproveTuiOwner {
  protected createStructuredAgentSessionRecoverTuiOwnerCallback() {
    return async (record) => {
      const identity = record.lease.ownerProcess
      const head = record.providerHandleChain.at(-1)
      if (
        !identity ||
        !head ||
        (head.handle.provider !== 'codex' && head.handle.provider !== 'claude')
      ) {
        throw new Error('agent_session_identity_required')
      }
      const provider = head.handle.provider
      const providerSessionId = provider === 'claude' ? head.handle.sessionId : head.handle.threadId
      let candidate = [...this.ptysById.values()].find(
        (pty) =>
          pty.connected &&
          pty.launchToken === identity.spawnToken &&
          pty.launchAgent === provider &&
          pty.tabId &&
          pty.paneKey
      )
      let handle = candidate ? this.issueStructuredTuiPtyHandle(candidate) : null
      let durableOwner: { binding: AgentSessionOwnerBinding; incarnationId: string } | undefined
      if (!candidate) {
        const workspace = await this.resolveTerminalWorkspaceLaunchScope(
          `id:${record.location.workspaceId}`
        )
        const baseNamespace = this.getAgentSessionExecutionNamespace(workspace, provider)
        if (!baseNamespace || !runtimeWorktreeIdsEqual(workspace.id, record.location.workspaceId)) {
          throw new Error('agent_session_identity_required')
        }
        const claim = this.agentSessionClaimSigner.createClaim({
          namespace: { ...baseNamespace, providerRoot: record.accountHome.path },
          identity: canonicalizeAgentSessionIdentity(provider, {
            key: 'session_id',
            id: providerSessionId
          }),
          canonicalWorktreeId: workspace.id
        })
        const candidateEvaluations = [...this.ptysById.values()].flatMap((pty) =>
          pty.agentSessionOwners.map((owner) => {
            const session = this.getWorkspaceSessionForWorktree(owner.surface.worktreeId)
            const sessionWorktreeId = session
              ? resolveTerminalSessionWorktreeId(session, owner.surface.worktreeId)
              : null
            const persistedTab = sessionWorktreeId
              ? session?.tabsByWorktree[sessionWorktreeId]?.find(
                  (candidate) => candidate.id === owner.surface.tabId
                )
              : null
            const paneKey = makePaneKey(owner.surface.tabId, owner.surface.leafId)
            const persisted = {
              sessionResolved: Boolean(session && sessionWorktreeId),
              tabPresent: Boolean(persistedTab),
              ptyId:
                session?.terminalLayoutsByTabId[owner.surface.tabId]?.ptyIdsByLeafId?.[
                  owner.surface.leafId
                ] ?? null,
              incarnationId: session?.terminalPtyIncarnationsByPaneKey?.[paneKey] ?? null
            }
            const evaluation = evaluateStructuredTuiRecoveryClaim(
              {
                expectedWorkspaceId: workspace.id,
                claimMatches: scopedAgentSessionClaimsEqual(owner.claim, claim),
                pty: {
                  connected: pty.connected,
                  ptyId: pty.ptyId,
                  incarnationId: pty.incarnationId,
                  worktreeId: pty.worktreeId
                },
                owner: { phase: owner.phase, ptyId: owner.ptyId, surface: owner.surface },
                persisted
              },
              runtimeWorktreeIdsEqual
            )
            return { pty, owner, persisted, evaluation }
          })
        )
        const recoveredCandidates = candidateEvaluations
          .filter(({ evaluation }) => evaluation.matches)
          .map(({ pty, owner }) => ({ pty, owner }))
        const recovered = recoveredCandidates.length === 1 ? recoveredCandidates[0] : null
        if (!recovered) {
          console.warn('[structured-tui-recovery] claim mismatch', {
            sessionId: record.sessionId,
            expectedWorkspaceId: workspace.id,
            persistedOwnerProcess: {
              hostId: identity.hostId,
              pid: identity.pid,
              processStartTimeMs: identity.processStartTimeMs,
              spawnTokenPresent: identity.spawnToken.length > 0
            },
            candidates: candidateEvaluations.map(({ pty, owner, persisted, evaluation }) => ({
              ptyId: pty.ptyId,
              incarnationId: pty.incarnationId,
              worktreeId: pty.worktreeId,
              ownerSurface: owner.surface,
              persisted,
              mismatchedFields: evaluation.mismatchedFields
            }))
          })
        }
        if (
          !recovered ||
          !(await this.proveRecoveredStructuredTuiPtyProcess(recovered.pty, identity, provider))
        ) {
          throw new Error('The owning agent terminal could not be recovered.')
        }
        candidate = recovered.pty
        candidate.tabId = recovered.owner.surface.tabId
        candidate.paneKey = makePaneKey(
          recovered.owner.surface.tabId,
          recovered.owner.surface.leafId
        )
        handle = this.issuePtyHandle(candidate)
        const recoveredIncarnationId = candidate.incarnationId
        if (handle && recoveredIncarnationId) {
          durableOwner = {
            binding: cloneAgentSessionOwnerBinding(recovered.owner),
            incarnationId: recoveredIncarnationId
          }
        }
      }
      if (!candidate?.tabId || !candidate.paneKey || !handle) {
        throw new Error('The owning agent terminal could not be recovered.')
      }
      agentSessionPtyWriteGate.bindPty(candidate.ptyId, record.sessionId)
      const proof =
        provider === 'codex'
          ? durableOwner
            ? await this.resolveRecoveredStructuredTuiTranscript({
                handle,
                paneKey: candidate.paneKey,
                threadId: head.handle.threadId,
                codexHome: record.accountHome.path,
                durableOwner
              })
            : await this.waitForStructuredTuiProof({
                handle,
                paneKey: candidate.paneKey,
                threadId: head.handle.threadId,
                spawnToken: identity.spawnToken,
                codexHome: record.accountHome.path,
                sessionId: record.sessionId
              })
          : await this.waitForStructuredClaudeTuiProof({
              handle,
              paneKey: candidate.paneKey,
              sessionId: head.handle.sessionId,
              previousLeafUuid: head.handle.leafUuid,
              projectsDir: join(record.accountHome.path, 'projects')
            })
      return {
        terminal: {
          handle,
          tabId: candidate.tabId,
          paneKey: candidate.paneKey,
          ptyId: candidate.ptyId
        },
        process: identity,
        link:
          provider === 'codex'
            ? codexProviderHandleLink({
                threadId: head.handle.threadId,
                resumed: true,
                fence: record.lease.runtimeFence,
                observedAt: Date.now()
              })
            : claudeProviderHandleLink({
                sessionId: head.handle.sessionId,
                leafUuid: proof.leafUuid ?? head.handle.leafUuid,
                resumed: true,
                fence: record.lease.runtimeFence,
                observedAt: Date.now()
              }),
        transcriptPath: proof.transcriptPath
      }
    }
  }
}
