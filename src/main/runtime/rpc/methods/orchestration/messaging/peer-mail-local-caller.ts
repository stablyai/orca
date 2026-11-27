import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationEntryCaller } from '../../../../orchestration/addressing/orchestration-caller-identity'
import type { OrchestrationCompatibilityCallerAuthority } from '../../../../orchestration/terminal-authority/orchestration-compatibility-authority'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'

const NOTHING_SENT = { effectsApplied: false } as const

/** The agent on this Orca that mail sent elsewhere answers to: a chat by its session, a terminal by its live pane. */
export function peerMailLocalCaller(args: {
  runtime: OrcaRuntimeService
  from: string | undefined
  orchestrationCaller: OrchestrationEntryCaller | undefined
  attestedCaller: OrchestrationCompatibilityCallerAuthority | undefined
}): { address: string; paneKey: string | null } {
  if (args.orchestrationCaller) {
    return { address: args.orchestrationCaller.address, paneKey: null }
  }
  const paneKey =
    args.from === undefined
      ? null
      : (args.attestedCaller?.paneKey ?? args.runtime.getLiveTerminalPaneKey(args.from))
  if (!args.from || !paneKey) {
    throw new OrchestrationError(
      'invalid_argument',
      'Mail to another computer needs a terminal or chat agent on this Orca to receive the replies. Run it from that agent. Nothing was sent.',
      NOTHING_SENT
    )
  }
  if (args.runtime.getOrchestrationDb().findActiveRemoteAttachmentForPane(paneKey)) {
    throw new OrchestrationError(
      'invalid_argument',
      "This terminal is a worker for another Orca's Run; its mail goes to that Run's coordinator, not to other servers. Nothing was sent.",
      NOTHING_SENT
    )
  }
  return { address: args.from, paneKey }
}
