import type { CanUseTool, OnUserDialog } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeControlSurface } from './sdk-transport/claude-agent-sdk-control-requests'
import type { DescendantTreeVerdict } from '../pty/process-retirement/pty-descendant-exit-verification'
import type { ProviderProcessCloseOptions } from '../provider-process/provider-process-close'
import type { ClaudeStructuredSdkOptions } from './structured/launch/claude-structured-launch-resolution'
import type { AgentSessionAdvisoryPolicy } from '../../shared/agent-session/agent-session-advisory-policy'
import type { AgentSessionAdvisoryReporter } from '../../shared/agent-session/agent-session-advisory-report'
import type { AgentSessionAdvisoryObservation } from '../../shared/agent-session/agent-session-advisory-receipt'

export type ClaudeStreamJsonLaunch = {
  /** Orca's resolved user CLI; the SDK falls back to a bundled binary that is not installed. */
  pathToClaudeCodeExecutable: string
  prefixArgs?: readonly string[]
  options: ClaudeStructuredSdkOptions
  cwd: string
  env?: Record<string, string>
  /** Delete these keys after merging inherited and launch env. */
  envToDelete?: readonly string[]
  advisoryPolicy?: AgentSessionAdvisoryPolicy
}

export type ClaudeStreamJsonConnectionHandlers = {
  onAdvisoryReport?: AgentSessionAdvisoryReporter
  onAdvisoryObservation?: (value: AgentSessionAdvisoryObservation) => void
  onMessage?: (message: Record<string, unknown>) => void
  /** Raw stdout before the SDK reads it, for state that must keep wire order with permission requests. */
  onStdout?: (chunk: Buffer | string) => void
  /** The SDK handles request IDs, aborts and deduplication; cannot combine with permissionPromptToolName. */
  canUseTool?: CanUseTool
  /** `request_user_dialog` control; the CLI only emits kinds declared in `supportedDialogKinds`. */
  onUserDialog?: OnUserDialog
  /** A transport/process fault; a physical root exit arrives marked observed and is followed by onExit. */
  onFault?: (error: Error) => void
  /** Report observed root exit once; expected stays true even after an unproven close attempt. */
  onExit?: (error: Error, exit?: { expected: boolean }) => void
}

/** Root proof comes from our child handle or processless settlement; tree proof is independently verified. */
export type ClaudeChildExitVerdict = {
  root: DescendantTreeVerdict
  tree: DescendantTreeVerdict
  processless?: boolean
  killDelivered?: true
}

export type ClaudeStreamJsonConnection = ClaudeControlSurface & {
  readonly pid: number | undefined
  readonly closed: boolean
  /** What the ladder has observed so far; read after a `close()` that returned false. */
  readonly exitVerdict: ClaudeChildExitVerdict
  readonly executableMissing?: boolean
  exited?: Promise<Error>
  startupFailure?: () => Error | undefined
  pauseReading?: () => void
  resumeReading?: () => void
  send: (message: Record<string, unknown>, beforeDispatch?: () => Promise<void>) => Promise<void>
  /** Resolves true after processless settlement, or root exit plus observed tree exit. */
  close: (options?: ProviderProcessCloseOptions) => Promise<boolean>
}
