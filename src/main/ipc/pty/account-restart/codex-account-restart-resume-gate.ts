import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  codexAccountRestartPaneKey,
  codexAccountRestartStops,
  type CodexAccountRestartStops
} from './codex-account-restart-stops'

export class CodexAccountRestartResumeUnavailableError extends Error {
  constructor() {
    super("Couldn't resume on the new account. Restart the pane to try again.")
    this.name = 'CodexAccountRestartResumeUnavailableError'
  }
}

export type CodexAccountRestartResume = {
  providerSession: AgentProviderSessionMetadata | undefined
  resumeOnSelectedAccount: boolean
  /** Puts the intent back when this launch fails before its process starts. */
  unspend?: () => void
}

/** Every fresh local Codex resume passes here; only a proven restart stop switches its account. */
export async function resolveCodexAccountRestartResume(
  args: {
    launchAgent: string | undefined
    resumeProviderSession: AgentProviderSessionMetadata | undefined
    worktreeId: string | undefined
    tabId: string | undefined
    leafId: string | null | undefined
    /** An exact reattach launches nothing, so it leaves the intent unspent. */
    preAdopted: boolean
    /** A replacement spawn already names its own account switch. */
    replacesPtyId: string | undefined
    connectionId: string | null | undefined
    selectionRuntime: 'host' | 'wsl'
    isDaemonHostSpawn: boolean
  },
  stops: CodexAccountRestartStops = codexAccountRestartStops
): Promise<CodexAccountRestartResume> {
  const passthrough = {
    providerSession: args.resumeProviderSession,
    resumeOnSelectedAccount: false
  }
  if (
    args.launchAgent !== 'codex' ||
    args.preAdopted ||
    !args.resumeProviderSession ||
    args.replacesPtyId ||
    !args.worktreeId ||
    !args.tabId ||
    !args.leafId
  ) {
    return passthrough
  }
  const decision = await stops.resolveResume({
    paneKey: codexAccountRestartPaneKey({
      worktreeId: args.worktreeId,
      tabId: args.tabId,
      leafId: args.leafId
    }),
    providerSession: args.resumeProviderSession
  })
  if (decision.kind !== 'selected') {
    // No intent, a different thread, or no writer proof: an ordinary pinned resume keeps the notice discoverable.
    return passthrough
  }
  if (args.connectionId || args.selectionRuntime === 'wsl' || !args.isDaemonHostSpawn) {
    // The route changed after the stop: never fall back silently to a shell or the old account.
    decision.unspend()
    throw new CodexAccountRestartResumeUnavailableError()
  }
  return {
    // Pinned to the transcript captured before the stop, so ID-only lookup cannot pick another home's copy.
    providerSession: decision.providerSession,
    resumeOnSelectedAccount: true,
    unspend: decision.unspend
  }
}
