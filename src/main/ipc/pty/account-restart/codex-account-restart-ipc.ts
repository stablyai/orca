import type {
  CodexAccountRestartReleaseRequest,
  CodexAccountRestartWithdrawRequest
} from '../../../../shared/agent-accounts/codex/codex-account-restart-stop'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import type { PtyFencedTerminationOutcome } from '../../../../shared/terminal/pty/lifecycle/pty-fenced-termination'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { agentHookServer } from '../../../agent-hooks/server/agent-hook-server'
import { getSelectedCodexAccountIdForTarget } from '../../../codex-accounts/account-management/runtime-selection'
import { getCodexSelectionEpoch } from '../../../codex-accounts/account-management/codex-selection-epoch'
import { peekLoadedCodexPaneAccount } from '../../../codex/configuration/homes/codex-pane-account-registry'
import { getSystemCodexHomePath } from '../../../codex/configuration/homes/codex-home-paths'
import {
  attributedCodexHome,
  transcriptIsUnderCodexHome
} from './codex-account-restart-launch-route'
import { transcriptHasNoOpenWriter } from './codex-transcript-writer-check'
import { PtyExitProof } from '../../../pty/process-retirement/pty-exit-proof'
import { getPtyIpc } from '../pty-host-bindings'
import { resolvePersistedStablePaneOwner } from '../pane/stable-owner'
import { finishPtyShutdown } from '../provider/liveness'
import { ptyIncarnationById } from '../provider/ownership-state'
import { resolvePtyExecutionHost, tryGetProviderForPty } from '../provider/registry'
import type { PtyKillIpcDeps } from '../ipc/renderer-kill'
import {
  codexAccountRestartPaneKey,
  codexAccountRestartStops,
  type CodexAccountRestartNotStartedReason,
  type CodexAccountRestartStopRequest,
  type CodexRestartOccupant,
  type CodexRestartStopOutcome
} from './codex-account-restart-stops'

export type CodexAccountRestartIpcDeps = PtyKillIpcDeps & {
  getSettings?: () => GlobalSettings | undefined
  /** Whether a ready window would receive an exit sent now; absent means yes. */
  isRendererLive?: () => boolean
  /** Whether no process still holds the transcript open; absent means the platform check. */
  transcriptHasNoOpenWriter?: (transcriptPath: string) => Promise<boolean>
}

// A stop can outlive the window that asked for it; every step reads the deps current at that moment.
let currentDeps: CodexAccountRestartIpcDeps | null = null

export function installCodexAccountRestartIpcHandlers(deps: CodexAccountRestartIpcDeps): void {
  currentDeps = deps
  const current = (): CodexAccountRestartIpcDeps => currentDeps ?? deps
  getPtyIpc().handle(
    'pty:stopCodexForAccountRestart',
    (_event, args: CodexAccountRestartStopRequest) =>
      codexAccountRestartStops.request(args, {
        resolveOccupant: (request) => resolveCodexRestartOccupant(current(), request),
        stop: (occupant, authorize) => stopCodexRestartOccupant(current, occupant, authorize)
      })
  )
  getPtyIpc().handle(
    'pty:releaseCodexAccountRestartPane',
    (_event, args: CodexAccountRestartReleaseRequest) => {
      if (
        typeof args?.worktreeId === 'string' &&
        typeof args.tabId === 'string' &&
        typeof args.leafId === 'string' &&
        Array.isArray(args.opIds)
      ) {
        codexAccountRestartStops.releaseRefusedPane(
          codexAccountRestartPaneKey(args),
          args.opIds.filter((opId): opId is string => typeof opId === 'string')
        )
      }
    }
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
  // A shared or unrecorded home names no account; the launch account cannot be proven.
  if (account.homeRoute !== 'account-home' && account.homeRoute !== 'real-home') {
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
  const codexHome = attributedCodexHome(account, settings, getSystemCodexHomePath())
  if (!codexHome || !transcriptIsUnderCodexHome(transcriptPath, codexHome)) {
    // The child's effective home is not the one main attributed: stop nothing, the user restarts it.
    return 'resume-unavailable'
  }
  return {
    ptyId,
    incarnationId,
    provenance: { threadId: session.id, transcriptPath },
    // Any later selection write (even back to the same account) supersedes this answer.
    selectionEpoch: getCodexSelectionEpoch()
  }
}

async function stopCodexRestartOccupant(
  current: () => CodexAccountRestartIpcDeps,
  occupant: CodexRestartOccupant,
  authorize: () => boolean
): Promise<CodexRestartStopOutcome | 'not-authorized'> {
  await current().getLocalPtyProviderStartupPromise(LOCAL_EXECUTION_HOST_ID)
  const provider = tryGetProviderForPty(occupant.ptyId)
  if (!provider?.killFenced) {
    return 'service-outdated'
  }
  // The last boundary main controls: Dismiss or reselection during the waits above sends nothing.
  if (!authorize()) {
    return 'not-authorized'
  }
  // A sleep, as hibernation's stop is: the pane's agent keeps its resume identity through the exit.
  const settleSleep = current().runtime?.intentionalPtyStops?.mark(
    occupant.ptyId,
    'reversible',
    occupant.incarnationId
  )
  let outcome: CodexRestartStopOutcome | 'not-authorized' = 'unknown'
  try {
    outcome = await killCodexRestartOccupant(
      current,
      provider.killFenced.bind(provider),
      occupant,
      authorize
    )
    return outcome
  } finally {
    // Only a stop that never ran leaves the process awake; an unknown one may still exit.
    settleSleep?.(
      outcome !== 'not-authorized' && outcome !== 'refused' && outcome !== 'service-outdated'
    )
  }
}

async function killCodexRestartOccupant(
  current: () => CodexAccountRestartIpcDeps,
  killFenced: NonNullable<IPtyProvider['killFenced']>,
  occupant: CodexRestartOccupant,
  authorize: () => boolean
): Promise<CodexRestartStopOutcome | 'not-authorized'> {
  let revoked = false
  let outcome: PtyFencedTerminationOutcome
  try {
    outcome = await killFenced(
      {
        id: occupant.ptyId,
        expectedIncarnationId: occupant.incarnationId,
        requireNoAgentOwner: true,
        requireUnattached: false
      },
      {
        // Sleep, not close: the pane wakes on this session, so no kill tombstone may refuse it.
        keepHistory: true,
        // Re-checked after route, lock and connection waits, right before the kill is written.
        beforeRequest: () => {
          revoked = !authorize()
          return !revoked
        }
      }
    )
  } catch {
    return 'unknown'
  }
  if (revoked) {
    return 'not-authorized'
  }
  if (outcome.outcome === 'ended') {
    // Deliver through the window registered now, not the one that asked for the stop.
    deliverRestartReceiptExit(current(), occupant)
    // The root ended either way; only positive descendant evidence lets another account read the transcript.
    if (outcome.writersExited !== true) {
      return 'ended-unproven'
    }
    // The descendants the stop saw are gone; the transcript's own writer must be too, before any read.
    const writerGone = await (current().transcriptHasNoOpenWriter ?? transcriptHasNoOpenWriter)(
      occupant.provenance.transcriptPath
    )
    return writerGone ? 'ended' : 'ended-unproven'
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
  const liveIncarnationId = ptyIncarnationById.get(occupant.ptyId)
  if (liveIncarnationId !== undefined && liveIncarnationId !== occupant.incarnationId) {
    // A newer process owns this id; the stopped one's exit must not touch it.
    return
  }
  const classification = codexAccountRestartStops.classifyExit(
    occupant.ptyId,
    occupant.incarnationId,
    'fenced-receipt'
  )
  if (classification === 'ordinary' || classification === 'duplicate') {
    return
  }
  if (classification === 'restart-renderer-only' && deps.isRendererLive?.() === false) {
    // Still no window to tell; keep it owed to the next one that signals ready.
    codexAccountRestartStops.noteRendererUndelivered(occupant.ptyId, occupant.incarnationId)
    return
  }
  const settleStop = deps.runtime?.intentionalPtyStops?.mark(
    occupant.ptyId,
    'replaced',
    occupant.incarnationId
  )
  try {
    if (classification === 'restart') {
      deps.runtime?.markPtyStopRequested?.(occupant.ptyId)
      finishPtyShutdown(
        occupant.ptyId,
        null,
        deps.store,
        PtyExitProof.from('shutdown-acknowledged', occupant.incarnationId)
      )
      // The daemon confirmed the root ended; the pane's resume brings it back, so Dispatch waits.
      deps.runtime?.onPtyExit(occupant.ptyId, -1, occupant.incarnationId, {
        hostExitConfirmed: true,
        paneRespawning: true
      })
    }
    deps.rememberSyntheticKillExit(occupant.ptyId, occupant.incarnationId)
    deps.sendPtyExitToRenderer({
      id: occupant.ptyId,
      code: -1,
      incarnationId: occupant.incarnationId
    })
    if (deps.isRendererLive?.() === false) {
      codexAccountRestartStops.noteRendererUndelivered(occupant.ptyId, occupant.incarnationId)
    }
  } finally {
    settleStop?.(true)
  }
}
