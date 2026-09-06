// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithGetWorktreePs } from './orca-runtime-get-worktree-ps'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { readStructuredTuiProcessIdentity } from './structured-tui-process-identity'
import {
  PROCESS_START_TIME_TOLERANCE_MS,
  probeAgentSessionProcessIdentity
} from './agent-session-process-identity-probe'
import type { StructuredTuiOwner } from '../native-chat/agent-session-wire/structured-agent-session-handoff-types'
import { resolvePinnedCodexRolloutProof } from '../codex/codex-tui-rollout-proof'
import { randomUUID } from 'node:crypto'
import { waitForStructuredTuiExitProof } from './structured-tui-exit-proof'

export class OrcaRuntimeWithProveRecoveredStructuredTuiPtyProcess extends OrcaRuntimeWithGetWorktreePs {
  protected async proveRecoveredStructuredTuiPtyProcess(
    pty: RuntimePtyWorktreeRecord,
    identity: NonNullable<AgentSessionRecord['lease']['ownerProcess']>,
    provider: 'codex' | 'claude' = 'codex'
  ): Promise<boolean> {
    const listings = await this.ptyController?.listProcesses?.(pty.connectionId)
    const listed = listings?.find(
      (candidate) => candidate.id === pty.ptyId && candidate.incarnationId === pty.incarnationId
    )
    if (!listed?.rootProcessId || identity.processStartTimeMs === null) {
      console.warn('[structured-tui-recovery] claimed PTY process mismatch', {
        ptyId: pty.ptyId,
        incarnationId: pty.incarnationId,
        rootProcessId: listed?.rootProcessId ?? null,
        mismatchedFields: [
          ...(!listed?.rootProcessId ? ['root-process-id'] : []),
          ...(identity.processStartTimeMs === null ? ['persisted-process-start-time'] : [])
        ]
      })
      return false
    }
    try {
      const observed = await readStructuredTuiProcessIdentity({
        hostId: identity.hostId,
        rootPid: listed.rootProcessId,
        spawnToken: identity.spawnToken,
        agent: provider
      })
      const matched = {
        hostId: observed.hostId === identity.hostId,
        pid: observed.pid === identity.pid,
        processStartTime:
          observed.processStartTimeMs !== null &&
          Math.abs(observed.processStartTimeMs - identity.processStartTimeMs) <=
            PROCESS_START_TIME_TOLERANCE_MS
      }
      if (!Object.values(matched).every(Boolean)) {
        console.warn('[structured-tui-recovery] claimed PTY process mismatch', {
          ptyId: pty.ptyId,
          incarnationId: pty.incarnationId,
          rootProcessId: listed.rootProcessId,
          persisted: {
            hostId: identity.hostId,
            pid: identity.pid,
            processStartTimeMs: identity.processStartTimeMs
          },
          observed: {
            hostId: observed.hostId,
            pid: observed.pid,
            processStartTimeMs: observed.processStartTimeMs
          },
          mismatchedFields: Object.entries(matched)
            .filter(([, matches]) => !matches)
            .map(([field]) => field)
        })
      }
      return Object.values(matched).every(Boolean)
    } catch (error) {
      console.warn('[structured-tui-recovery] claimed PTY process mismatch', {
        ptyId: pty.ptyId,
        incarnationId: pty.incarnationId,
        rootProcessId: listed.rootProcessId,
        mismatchedFields: [`${provider}-child-proof`],
        error: error instanceof Error ? error.message : String(error)
      })
      return false
    }
  }

  protected async closeStructuredTuiOwner(
    owner: StructuredTuiOwner
  ): Promise<{ transcriptPath?: string }> {
    if (this.ptysById.get(owner.terminal.ptyId)?.connected) {
      const current = this.refreshStructuredTuiOwnerBinding(owner)
      try {
        await this.closeTerminal(current.terminal.handle)
      } catch (error) {
        if (this.ptysById.get(owner.terminal.ptyId)?.connected) {
          throw error
        }
      }
    }
    await this.waitForStructuredTuiOwnerExit(owner)
    return owner.transcriptPath ? { transcriptPath: owner.transcriptPath } : {}
  }

  // The new exact `codex resume <thread>` child proves the resumed owner without
  // a first turn; the pinned rollout then binds its durable transcript.
  protected async waitForAdoptedStructuredTuiProof(input: {
    owner: StructuredTuiOwner
    threadId: string
    codexHome: string
  }): Promise<{ transcriptPath: string; leafUuid?: never }> {
    const assertPaneIdentity = (): void => {
      const pty = this.ptysById.get(input.owner.terminal.ptyId)
      if (!pty?.connected || pty.paneKey !== input.owner.terminal.paneKey) {
        throw new Error('The adopted terminal lost its pane identity.')
      }
    }
    assertPaneIdentity()
    const transcriptPath = await resolvePinnedCodexRolloutProof(input.codexHome, input.threadId)
    if (!transcriptPath) {
      throw new Error('The agent terminal did not prove the expected Codex rollout.')
    }
    assertPaneIdentity()
    const processProof = await probeAgentSessionProcessIdentity({ identity: input.owner.process })
    if (processProof.outcome !== 'identity-matched' || processProof.matchedOn.length === 0) {
      throw new Error('The resumed Codex process could not be re-proved.')
    }
    return { transcriptPath }
  }

  protected refreshStructuredTuiOwnerBinding(owner: StructuredTuiOwner): StructuredTuiOwner {
    const pty = this.ptysById.get(owner.terminal.ptyId)
    if (!pty?.connected) {
      throw new Error('The owning agent terminal lost its launch identity.')
    }
    const handle = this.issueStructuredTuiPtyHandle(pty)
    if (handle === owner.terminal.handle) {
      return owner
    }
    return { ...owner, terminal: { ...owner.terminal, handle } }
  }

  protected issueStructuredTuiPtyHandle(pty: RuntimePtyWorktreeRecord): string {
    const existingHandle = this.findHandleForPtyRecord(pty.ptyId)
    if (existingHandle) {
      this.handleByPtyId.set(pty.ptyId, existingHandle)
      return existingHandle
    }
    const handle = `term_${randomUUID()}`
    const syntheticId = `pty:${pty.ptyId}`
    this.syntheticTerminalHandles.add(handle)
    this.handles.set(handle, {
      handle,
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      worktreeId: pty.worktreeId,
      tabId: syntheticId,
      leafId: syntheticId,
      ptyId: pty.ptyId,
      ptyGeneration: 0
    })
    this.handleByPtyId.set(pty.ptyId, handle)
    return handle
  }

  protected async waitForStructuredTuiPtyExit(ptyId: string): Promise<void> {
    const deadline = Date.now() + 5_000
    while (this.ptysById.get(ptyId)?.connected === true) {
      if (Date.now() >= deadline) {
        throw new Error('terminal_handle_stale')
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  protected async waitForStructuredTuiOwnerExit(owner: StructuredTuiOwner): Promise<void> {
    await waitForStructuredTuiExitProof({
      identity: owner.process,
      waitForExit: () => this.waitForStructuredTuiPtyExit(owner.terminal.ptyId)
    })
  }

  protected async waitForStructuredTuiIdleOrExit(
    owner: StructuredTuiOwner,
    signal: AbortSignal
  ): Promise<'idle' | 'exited' | null> {
    const deadline = Date.now() + 250
    while (!signal.aborted && Date.now() < deadline) {
      if (!this.ptysById.get(owner.terminal.ptyId)?.connected) {
        await this.waitForStructuredTuiOwnerExit(owner)
        return 'exited'
      }
      if (this.structuredTuiStatus(owner) === 'idle') {
        return 'idle'
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return null
  }
}
