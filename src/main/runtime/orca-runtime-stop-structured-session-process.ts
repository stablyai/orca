// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithProveRecoveredStructuredTuiPtyProcess } from './orca-runtime-prove-recovered-structured-tui-pty-process'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { probeAgentSessionProcessIdentity } from './agent-session-process-identity-probe'
import type { StructuredTuiOwner } from '../native-chat/agent-session-wire/structured-agent-session-handoff-types'
import { buildTerminalWaitText } from './terminal-wait-tail-state'
import {
  detectTerminalWaitBlockedReason,
  isKnownReadyPromptPreview
} from './terminal-wait-detection'
import { hasStructuredTuiIdleEvidence } from './structured-tui-idle-evidence'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { proveCodexTuiRollout } from '../codex/codex-tui-rollout-proof'
import { ClaudeTranscriptTailIncompleteError } from '../claude/claude-transcript-branch-proof'
import {
  readClaudeTranscriptLeafUuid,
  resolveSessionFilePath
} from '../native-chat/session-file-resolver'
import { isPathWithinDirectory } from './orca-runtime-core'

export class OrcaRuntimeWithStopStructuredSessionProcess extends OrcaRuntimeWithProveRecoveredStructuredTuiPtyProcess {
  protected async stopStructuredSessionProcess(record: AgentSessionRecord): Promise<void> {
    const identity = record.lease.ownerProcess
    if (!identity) {
      return
    }
    const proof = await probeAgentSessionProcessIdentity({ identity })
    if (proof.outcome === 'pid-absent' || proof.outcome === 'identity-mismatch') {
      return
    }
    if (proof.outcome !== 'identity-matched' || proof.matchedOn.length === 0) {
      throw new Error('The recovered owner process could not be stopped safely.')
    }
    try {
      process.kill(identity.pid, 'SIGTERM')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error
      }
      return
    }
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const current = await probeAgentSessionProcessIdentity({ identity })
      if (current.outcome === 'pid-absent' || current.outcome === 'identity-mismatch') {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    // SIGTERM is only a request. Escalate once, then require an independent
    // absence probe before allowing the lease transition to proceed.
    try {
      process.kill(identity.pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error
      }
      return
    }
    const forcedDeadline = Date.now() + 5_000
    while (Date.now() < forcedDeadline) {
      const current = await probeAgentSessionProcessIdentity({ identity })
      if (current.outcome === 'pid-absent' || current.outcome === 'identity-mismatch') {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('The recovered owner process did not exit after forced termination.')
  }

  protected structuredTuiStatus(owner: StructuredTuiOwner): 'idle' | 'busy' {
    const pty = this.ptysById.get(owner.terminal.ptyId)
    const paneKey = pty?.paneKey ?? owner.terminal.paneKey
    const explicit = this.getFreshExplicitAgentStatusForHandle(owner.terminal.handle, paneKey)
    if (explicit) {
      return explicit.status === 'idle' ? 'idle' : 'busy'
    }
    if (pty?.connected) {
      const text = buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
      const blocked = detectTerminalWaitBlockedReason(text) !== null
      if (!blocked && isKnownReadyPromptPreview(text)) {
        return 'idle'
      }
      return hasStructuredTuiIdleEvidence({
        blocked,
        status: pty.lastAgentStatus,
        statusObservedLive: pty.lastAgentStatusObservedLive
      })
        ? 'idle'
        : 'busy'
    }
    return 'busy'
  }

  protected async waitForStructuredTuiProof(input: {
    handle: string
    paneKey: string
    threadId: string
    spawnToken: string
    codexHome: string
    sessionId: string
  }): Promise<{ transcriptPath?: string; leafUuid?: never }> {
    const readBoundPty = (): RuntimePtyWorktreeRecord => {
      const pty = this.getLivePtyForHandle(input.handle)?.pty
      if (
        !pty?.connected ||
        pty.paneKey !== input.paneKey ||
        pty.launchAgent !== 'codex' ||
        pty.launchToken !== input.spawnToken
      ) {
        throw new Error('The resumed terminal lost its launch identity.')
      }
      return pty
    }
    const initialPty = readBoundPty()
    const kittyKeyboardFlags = this.providerModeTrackersByPtyId.get(initialPty.ptyId)?.flags ?? 0
    return proveCodexTuiRollout({
      codexHome: input.codexHome,
      threadId: input.threadId,
      kittyKeyboardFlags,
      readOutput: () => {
        const pty = readBoundPty()
        return {
          text: buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview),
          lastOutputAt: pty.lastOutputAt
        }
      },
      write: (data) => {
        const pty = readBoundPty()
        return (
          this.ptyController?.writeAgentSessionProof?.(pty.ptyId, data, {
            sessionId: input.sessionId,
            spawnToken: input.spawnToken
          }) ?? false
        )
      }
    })
  }

  protected async waitForStructuredClaudeTuiProof(input: {
    handle: string
    paneKey: string
    sessionId: string
    previousLeafUuid: string | null
    projectsDir: string
    /** Set when this call launched a new Claude process; a cached transcript marker is not enough. */
    spawnToken?: string
    minimumProviderSessionReceivedAt?: number
  }): Promise<{ transcriptPath: string; leafUuid: string }> {
    const deadline = Date.now() + 15_000
    let incompleteTail: ClaudeTranscriptTailIncompleteError | null = null
    while (Date.now() < deadline) {
      const pty = this.getLivePtyForHandle(input.handle)?.pty
      if (!pty?.connected || pty.paneKey !== input.paneKey || pty.launchAgent !== 'claude') {
        throw new Error('The resumed Claude terminal lost its launch identity.')
      }
      if (input.spawnToken) {
        if (!this.hasProviderSessionObservationSource()) {
          throw new Error('The Claude terminal could not prove its fresh provider session.')
        }
        const observedProviderRow = this.findAdoptedProviderSession(
          input.paneKey,
          'claude',
          input.sessionId
        )
        if (
          !observedProviderRow ||
          observedProviderRow.launchToken !== input.spawnToken ||
          (input.minimumProviderSessionReceivedAt !== undefined &&
            observedProviderRow.receivedAt < input.minimumProviderSessionReceivedAt)
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          continue
        }
      }
      const transcriptPath = await resolveSessionFilePath('claude', input.sessionId, {
        claudeProjectsDir: input.projectsDir
      })
      if (transcriptPath) {
        if (!isPathWithinDirectory(input.projectsDir, transcriptPath)) {
          throw new Error('The Claude terminal reported a transcript outside its account root.')
        }
        try {
          const leafUuid = await readClaudeTranscriptLeafUuid(
            transcriptPath,
            input.sessionId,
            input.previousLeafUuid
          )
          return { transcriptPath, leafUuid }
        } catch (error) {
          if (!(error instanceof ClaudeTranscriptTailIncompleteError)) {
            throw error
          }
          incompleteTail = error
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (incompleteTail) {
      throw incompleteTail
    }
    throw new Error('The agent terminal did not prove the expected Claude session.')
  }
}
