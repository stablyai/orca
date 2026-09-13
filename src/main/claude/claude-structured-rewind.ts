import { AgentSessionRewindRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

export function claudeRewindRefusalFromMessage(
  message: Record<string, unknown>
): AgentSessionRewindRefusal | null {
  return message.type === 'result' &&
    message.subtype === 'error_during_execution' &&
    Array.isArray(message.errors) &&
    message.errors.some(
      (error) =>
        typeof error === 'string' && error.startsWith('Resume rejected by --resume-drops-turn:')
    )
    ? new AgentSessionRewindRefusal('provider-refused')
    : null
}

import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ClaudeStructuredLaunch } from './claude-structured-launch-resolution'
import type { ClaudeStructuredSessionAdapterDeps } from './claude-structured-session-state'

type Intent = NonNullable<StructuredAgentSessionAcquireInput['rewind']>

/** The proof authorization exists only for this acquisition's first proof attempt. */
export class ClaudeRewindAttempt {
  private refusal: AgentSessionRewindRefusal | null = null
  constructor(
    private intent: Intent | undefined,
    private readonly onProved?: (leafUuid: string) => Promise<void>
  ) {}

  observe(message: Record<string, unknown>): AgentSessionRewindRefusal | null {
    if (!this.intent) {
      return null
    }
    this.refusal ??= claudeRewindRefusalFromMessage(message)
    return this.refusal
  }

  applyLaunch(
    launch: ClaudeStructuredLaunch,
    deps: Pick<ClaudeStructuredSessionAdapterDeps, 'readTranscriptLeaf'>
  ): void {
    if (!this.intent) {
      return
    }
    if (!launch.resumed || !deps.readTranscriptLeaf) {
      throw new AgentSessionRewindRefusal('unsupported')
    }
    launch.options = {
      ...launch.options,
      resume: launch.providerSessionId,
      resumeSessionAt: this.intent.targetUuid,
      ...(this.intent.dropsTurn ? { resumeDropsTurn: this.intent.dropsTurn } : {})
    }
    launch.resumeLeafUuid = this.intent.targetUuid
  }

  async prove(
    launch: ClaudeStructuredLaunch,
    deps: Pick<ClaudeStructuredSessionAdapterDeps, 'readTranscriptLeaf'>
  ): Promise<string | null> {
    const intent = this.intent
    this.clear()
    if (this.refusal) {
      throw this.refusal
    }
    if (!intent) {
      return null
    }
    let leaf: string | null
    try {
      leaf = await deps.readTranscriptLeaf!({
        providerSessionId: launch.providerSessionId,
        previousLeafUuid: intent.previousLeafUuid,
        intentionalRewindUuid: intent.targetUuid,
        claudeConfigDir: launch.claudeConfigDir
      })
      if (leaf !== intent.targetUuid) {
        throw new AgentSessionRewindRefusal('proof-mismatch')
      }
    } catch (error) {
      throw error instanceof AgentSessionRewindRefusal
        ? error
        : new AgentSessionRewindRefusal('proof-mismatch')
    }
    // Persistence failure is an unknown outcome, never evidence that the provider refused.
    await this.onProved?.(leaf)
    return leaf
  }

  clear(): void {
    this.intent = undefined
  }
}

/** An interrupted, unproved rewind restores its original cursor without ancestor authorization. */
export async function proveClaudeRewindRecovery(
  recovery: StructuredAgentSessionAcquireInput['rewindRecovery'],
  launch: ClaudeStructuredLaunch,
  deps: Pick<ClaudeStructuredSessionAdapterDeps, 'readTranscriptLeaf'>
): Promise<string | null> {
  if (!recovery) {
    return null
  }
  if (!launch.resumed || launch.resumeLeafUuid !== recovery.leafUuid || !deps.readTranscriptLeaf) {
    throw new AgentSessionRewindRefusal('proof-mismatch')
  }
  const leaf = await deps.readTranscriptLeaf({
    providerSessionId: launch.providerSessionId,
    previousLeafUuid: recovery.leafUuid,
    claudeConfigDir: launch.claudeConfigDir
  })
  if (leaf !== recovery.leafUuid) {
    throw new AgentSessionRewindRefusal('proof-mismatch')
  }
  await recovery.onProved()
  return leaf
}
