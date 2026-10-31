import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import type { StructuredAgentStartupFailure } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ProviderReceiveDisposition } from '../provider-process/provider-source-completion'
import type { CanUseTool, OnUserDialog } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeControlSurface } from './claude-agent-sdk-control-requests'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import type { ClaudeStructuredSdkOptions } from './claude-structured-launch-resolution'

export type ClaudeStreamJsonLaunch = {
  /** Orca's resolved user CLI; the SDK falls back to a bundled binary that is not installed. */
  pathToClaudeCodeExecutable: string
  prefixArgs?: readonly string[]
  options: ClaudeStructuredSdkOptions
  account?: AgentSessionAccountKind
  cwd: string
  env?: Record<string, string>
  /** Delete these keys after merging inherited and launch env. */
  envToDelete?: readonly string[]
}

export type ClaudeStreamJsonConnectionHandlers = {
  onMessage?: (message: Record<string, unknown>) => void
  /** The SDK handles request IDs, aborts and deduplication; cannot combine with permissionPromptToolName. */
  canUseTool?: CanUseTool
  /** `request_user_dialog` control; the CLI only emits kinds declared in `supportedDialogKinds`. */
  onUserDialog?: OnUserDialog
  /** A transport/process fault that is not itself first-hand root exit proof. */
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

export type ClaudeCloseOutcome = {
  accepted: boolean
  physical: ClaudeChildExitVerdict
  receive: ProviderReceiveDisposition
}

export type ClaudeStreamJsonConnection = ClaudeControlSurface & {
  /** Physical/transport diagnosis; it cannot replace the original initialize result. */
  readonly transportError?: Error | null
  readonly startupFailure?: StructuredAgentStartupFailure
  startupSettled?: () => Promise<void>
  rejectStartup?: (error: Error) => void
  readonly pid: number | undefined
  readonly closed: boolean
  /** What the ladder has observed so far; read after a `close()` that returned false. */
  readonly exitVerdict: ClaudeChildExitVerdict
  readonly executableMissing?: boolean
  pauseReading?: () => void
  resumeReading?: () => void
  send: (message: Record<string, unknown>, beforeDispatch?: () => Promise<void>) => Promise<void>
  /** Receipt is independent from actual processless/root/tree/kill evidence. */
  closeOutcome: () => Promise<ClaudeCloseOutcome>
  /** Rejects genuine receive failure; otherwise returns physical close acceptance. */
  close: () => Promise<boolean>
}
