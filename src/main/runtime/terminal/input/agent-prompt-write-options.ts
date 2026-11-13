import type { RuntimeTerminalWriteOptions } from './runtime-terminal-writer'
import type { TerminalInputKind } from '../../../../shared/terminal/input/terminal-input-kind'
import type { RuntimeTerminalSend } from '../../../../shared/runtime-terminal-send-contract'

/** Agent-prompt writes add the correlation inputs a queued-acceptance receipt needs. */
export type RuntimeAgentPromptWriteOptions = Omit<RuntimeTerminalWriteOptions, 'inputKind'> & {
  /** `launch` for the prompt an agent starts with; `driving` for any prompt sent to a running one. */
  inputKind: Exclude<TerminalInputKind, 'query-reply'>
  /** Caller observation may end without cancelling a paste already accepted by the host. */
  observationSignal?: AbortSignal
  /** Raw prompt text for submit scheduling; not written, only used for line-aware delays. */
  promptForSchedule?: string
  /** Caller observed composer input acceptance; schedule Enter using desktop draft-paste timing instead of render settlement. */
  composerReady?: boolean
  /** See buildAgentPromptPasteBytes. */
  leadLine?: string
  /** Return an accepted receipt as soon as input lands, instead of waiting for the turn. */
  acceptQueued?: boolean
  observationTimeoutMs?: number
  requestId?: string
  onInputAccepted?: (send: RuntimeTerminalSend) => void
  /** Wait through agent_prompt_blocked permissions until answer, exit, binding change or abort. */
  onPermission?: 'refuse' | 'wait'
  /** Refuse binding changes with terminal_handle_stale; never send admitted prompt text to a replacement process. */
  expectedBinding?: AgentPromptExpectedBinding
  /** Run on accepted Enter write, including OMP paste framing; later abort cannot undo submitted text. */
  onSubmitWritten?: () => void
}

export type AgentPromptExpectedBinding = { ptyId: string; processIncarnation: string }
