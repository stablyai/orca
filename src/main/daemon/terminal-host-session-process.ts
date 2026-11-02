import {
  discardStagedStartupCommand,
  type StartupCommandStaging
} from '../../shared/startup-command-staging'
import type { TerminalHostSessionCreateDependencies } from './terminal-host-session-create'
import { enumerateDirectoryOnce } from './directory-enumeration-probe'
import type { InternalCreateOrAttachOptions } from './terminal-host-agent-session-claim'
import type { TerminalSpawnGate } from './terminal-spawn-gate'
import type { LegacyRestoreDetails } from './legacy-restore-records'
import { TerminalAttachCanceledError } from './daemon-errors'
import { sharedPromiseSettlementWaiters } from '../../shared/promise-settlement-waiters'

export function createSessionExitHandler(
  onSessionExit: TerminalHostSessionCreateDependencies['onSessionExit'],
  sessionId: string,
  generation: string | undefined,
  staging: { current?: StartupCommandStaging },
  spawnGate: TerminalSpawnGate | undefined
): () => void {
  return () => {
    discardStagedStartupCommand(staging.current)
    spawnGate?.onSessionExit(sessionId)
    onSessionExit(sessionId, generation)
  }
}

export function describeAgentRestore(
  opts: InternalCreateOrAttachOptions
): LegacyRestoreDetails | undefined {
  if (!opts.command || (!opts.launchAgent && !opts.agentSessionEnsure)) {
    return undefined
  }
  return {
    sessionId: opts.sessionId,
    agent: opts.launchAgent ?? opts.agentSessionEnsure?.claim.agent ?? null,
    cwd: opts.cwd ?? null,
    worktreeId: opts.agentSessionEnsure?.surface.worktreeId ?? null,
    command: opts.command,
    identityDigest: opts.agentSessionEnsure?.claim.identityDigest ?? null
  }
}

export async function isCwdReadableByThisProcess(
  cwd: string,
  opts: Pick<InternalCreateOrAttachOptions, 'sessionId' | 'cancelSignal'>
): Promise<boolean | null> {
  const outcome = await sharedPromiseSettlementWaiters(enumerateDirectoryOnce(cwd))
    .wait({
      timeoutMs: 1_000,
      signal: opts.cancelSignal,
      createAbortError: () => new TerminalAttachCanceledError(opts.sessionId)
    })
    .catch((error: unknown) => {
      if (error instanceof TerminalAttachCanceledError) {
        throw error
      }
      return null
    })
  return outcome === null ? null : outcome !== 'denied'
}
