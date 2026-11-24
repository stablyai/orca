import type { CodexAccountRestartWithdrawRequest } from '../../../../shared/agent-accounts/codex/codex-account-restart-stop'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { agentHookServer } from '../../../agent-hooks/server/agent-hook-server'
import { getSelectedCodexAccountIdForTarget } from '../../../codex-accounts/account-management/runtime-selection'
import { peekLoadedCodexPaneAccount } from '../../../codex/configuration/homes/codex-pane-account-registry'
import { PtyExitProof } from '../../../pty/process-retirement/pty-exit-proof'
import { getPtyIpc } from '../pty-host-bindings'
import { resolvePersistedStablePaneOwner } from '../pane/stable-owner'
import { finishPtyShutdown } from '../provider/liveness'
import { ptyIncarnationById } from '../provider/ownership-state'
import { resolvePtyExecutionHost, tryGetProviderForPty } from '../provider/registry'
import type { PtyKillIpcDeps } from '../ipc/renderer-kill'
import {
  codexAccountRestartStops,
  type CodexAccountRestartNotStartedReason,
  type CodexAccountRestartStopRequest,
  type CodexRestartOccupant,
  type CodexRestartStopOutcome
} from './codex-account-restart-stops'

export type CodexAccountRestartIpcDeps = PtyKillIpcDeps & {
  getSettings?: () => GlobalSettings | undefined
}

export function installCodexAccountRestartIpcHandlers(deps: CodexAccountRestartIpcDeps): void {
  getPtyIpc().handle(
    'pty:stopCodexForAccountRestart',
    (_event, args: CodexAccountRestartStopRequest) =>
      codexAccountRestartStops.request(args, {
        resolveOccupant: (request) => resolveCodexRestartOccupant(deps, request),
        stop: (occupant) => stopCodexRestartOccupant(deps, occupant)
      })
  )
  getPtyIpc().handle(
    'pty:withdrawCodexAccountRestart',
    (_event, args: CodexAccountRestartWithdrawRequest) => codexAccountRestartStops.withdraw(args)
  )
}

/** Admission starts from the pane key, never the PTY id, and re-derives every fact from the host. */
export function resolveCodexRestartOccupant(
  deps: CodexAccountRestartIpcDeps,
  request: CodexAccountRestartStopRequest
): CodexRestartOccupant | CodexAccountRestartNotStartedReason {
  let paneKey: string
  try {
    paneKey = makePaneKey(request.tabId, request.leafId)
  } catch {
    return 'invalid'
  }
  const owner = resolvePersistedStablePaneOwner(deps.store, paneKey, request.worktreeId, null)
  if (!owner) {
    return 'superseded'
  }
  // Same-pane turnover re-qualifies the new occupant below; a reused id on another pane never matches.
  const ptyId = owner.ptyId
  if (isRemoteRuntimePtyId(ptyId) || resolvePtyExecutionHost(ptyId) !== LOCAL_EXECUTION_HOST_ID) {
    return 'unsupported'
  }
  const provider = tryGetProviderForPty(ptyId)
  // A local route that cannot fence a stop never falls back to an unfenced kill: it stays manual.
  if (!provider?.killFenced || provider.supportsFencedTermination?.(ptyId) !== true) {
    return 'service-outdated'
  }
  const incarnationId = ptyIncarnationById.get(ptyId)
  if (!incarnationId || (owner.incarnationId && owner.incarnationId !== incarnationId)) {
    return 'superseded'
  }
  // The stale notice that offered this restart already loaded attribution, so main never reads disk here.
  const account = peekLoadedCodexPaneAccount(ptyId)
  if (!account) {
    return 'not-stale'
  }
  // WSL and other lanes without a same-thread selected-account resume stay manual.
  if (account.selectionKey !== 'host' || account.homeRoute === 'wsl-home') {
    return 'resume-unavailable'
  }
  const settings = deps.getSettings?.()
  if (
    !settings ||
    account.accountId === getSelectedCodexAccountIdForTarget(settings, { runtime: 'host' })
  ) {
    return 'not-stale'
  }
  const session = agentHookServer
    .getStatusSnapshotForPane(paneKey)
    .find((row) => row.agentType === 'codex' && row.executionHost !== 'shared')?.providerSession
  const transcriptPath = session?.transcriptPath?.trim()
  if (!session?.id || !transcriptPath) {
    // Without the verified thread and its transcript, the resume could not prove the same conversation.
    return 'no-session'
  }
  return {
    ptyId,
    incarnationId,
    provenance: { threadId: session.id, transcriptPath }
  }
}

async function stopCodexRestartOccupant(
  deps: CodexAccountRestartIpcDeps,
  occupant: CodexRestartOccupant
): Promise<CodexRestartStopOutcome> {
  await deps.getLocalPtyProviderStartupPromise(LOCAL_EXECUTION_HOST_ID)
  const provider = tryGetProviderForPty(occupant.ptyId)
  if (!provider?.killFenced) {
    return 'service-outdated'
  }
  let outcome: Awaited<ReturnType<NonNullable<typeof provider.killFenced>>>
  try {
    outcome = await provider.killFenced({
      id: occupant.ptyId,
      expectedIncarnationId: occupant.incarnationId,
      requireNoAgentOwner: true,
      requireUnattached: false
    })
  } catch {
    return 'unknown'
  }
  if (outcome.outcome === 'ended') {
    deliverRestartReceiptExit(deps, occupant)
    // The root ended either way; only positive descendant evidence lets another account read the transcript.
    return outcome.writersExited === true ? 'ended' : 'ended-unproven'
  }
  if (outcome.outcome === 'refused' && outcome.reason === 'unsupported') {
    return 'service-outdated'
  }
  if (outcome.outcome === 'refused' && outcome.reason !== 'unverifiable') {
    return 'refused'
  }
  return 'unknown'
}

/** A receipt that arrives before (or instead of) the stream exit is the logical exit. */
function deliverRestartReceiptExit(
  deps: CodexAccountRestartIpcDeps,
  occupant: CodexRestartOccupant
): void {
  const classification = codexAccountRestartStops.classifyExit(
    occupant.ptyId,
    occupant.incarnationId,
    'fenced-receipt'
  )
  if (
    classification !== 'restart' ||
    ptyIncarnationById.get(occupant.ptyId) !== occupant.incarnationId
  ) {
    return
  }
  const settleStop = deps.runtime?.intentionalPtyStops?.mark(
    occupant.ptyId,
    'replaced',
    occupant.incarnationId
  )
  try {
    deps.runtime?.markPtyStopRequested?.(occupant.ptyId)
    finishPtyShutdown(
      occupant.ptyId,
      null,
      deps.store,
      PtyExitProof.from('shutdown-acknowledged', occupant.incarnationId)
    )
    // The pane's normal resume brings this conversation back, so an active Dispatch waits for it.
    deps.runtime?.onPtyExit(occupant.ptyId, -1, occupant.incarnationId, {
      paneRespawning: true
    })
    deps.rememberSyntheticKillExit(occupant.ptyId, occupant.incarnationId)
    deps.sendPtyExitToRenderer({
      id: occupant.ptyId,
      code: -1,
      incarnationId: occupant.incarnationId
    })
  } finally {
    settleStop?.(true)
  }
}
