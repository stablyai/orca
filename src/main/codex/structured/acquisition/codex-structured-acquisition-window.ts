import type {
  AgentSessionExecutionExecutable,
  AgentSessionExecutionUsage,
  AgentSessionExecutionEvidence
} from '../../../../shared/agent-session/agent-session-execution-evidence'
import { CodexAppliedSettings } from '../catalog/codex-structured-applied-settings'
import { CodexCumulativeUsageMeter } from '../journal/codex-cumulative-usage-meter'
import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import '../prompts/codex-structured-prompt-replies'
import { CodexPromptRegistry } from '../prompts/codex-prompt-registry'
import { createCodexExecutionControls } from '../launch/codex-execution-controls'
import type { AgentSessionExecutionPolicy } from '../../../../shared/agent-session/agent-session-execution-policy'
import type { AgentSessionExecutionReceiptWrite } from '../../../../shared/agent-session/agent-session-execution-receipt'
import type {
  AgentSessionExecutionReport,
  AgentSessionExecutionReporter
} from '../../../../shared/agent-session/agent-session-execution-report'

// Bound events retained before a session can route them.
export const MAX_CODEX_ACQUISITION_BUFFER_OPERATIONS = 1024
export const MAX_CODEX_ACQUISITION_BUFFER_BYTES = 4 * 1024 * 1024

export class CodexAcquisitionWindow {
  execution?: {
    policy: AgentSessionExecutionPolicy
    profileId: string
    executable?: AgentSessionExecutionExecutable
    controls: ReturnType<typeof createCodexExecutionControls>
    inputAdmitted: boolean
    toolsIsolated: boolean
    openedWorkspaceRoots?: string[]
    usage?: AgentSessionExecutionUsage
    usageUnverifiable?: boolean
    lastEvidence?: AgentSessionExecutionEvidence
    invalidated: boolean
    turnCompleted: boolean
    report?: AgentSessionExecutionReport
    reporter?: AgentSessionExecutionReporter
    record?: (write: AgentSessionExecutionReceiptWrite) => Promise<void>
    binding?: Omit<AgentSessionExecutionReceiptWrite, 'receipt'>
    checkpoint?: () => void
  }

  startExecution(
    input:
      | {
          policy: AgentSessionExecutionPolicy
          profileId: string
          executable?: AgentSessionExecutionExecutable
        }
      | undefined,
    close: () => Promise<boolean>,
    onFault: (reason: Error) => void
  ): void {
    if (input) {
      this.execution = {
        ...input,
        controls: createCodexExecutionControls(input.policy, close, onFault),
        inputAdmitted: false,
        toolsIsolated: false,
        invalidated: false,
        turnCompleted: false
      }
    }
  }
  nativeExecutionSettings?: Record<string, unknown>
  authRevision = 0
  readonly usageMeter = new CodexCumulativeUsageMeter()
  readonly appliedSettings = new CodexAppliedSettings()
  readonly prompts = new CodexPromptRegistry()
  /** Null until the spawn resolves; the handshake can already emit events. */
  connection: CodexAppServerConnection | null = null
  private readonly buffered: (() => void)[] = []
  private retainedBytes = 0
  private open = true
  private overflowed = false

  get isOverflowed(): boolean {
    return this.overflowed
  }

  /** False means the buffer closed or overflowed; only published sessions may deliver live. */
  buffer(event: () => void, retainedBytes = 256): boolean {
    if (!this.open) {
      return false
    }
    const bytes = Number.isFinite(retainedBytes) && retainedBytes > 0 ? Math.ceil(retainedBytes) : 1
    if (
      this.buffered.length >= MAX_CODEX_ACQUISITION_BUFFER_OPERATIONS ||
      this.retainedBytes + bytes > MAX_CODEX_ACQUISITION_BUFFER_BYTES
    ) {
      // Refuse the acquisition rather than dropping an event and continuing.
      this.overflowed = true
      this.open = false
      this.buffered.length = 0
      this.retainedBytes = 0
      return false
    }
    this.buffered.push(event)
    this.retainedBytes += bytes
    return true
  }

  drain(): (() => void)[] {
    this.open = false
    this.retainedBytes = 0
    return this.buffered.splice(0)
  }
}
