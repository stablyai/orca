import { WorktreeStartupDrafts } from './worktree-startup-drafts'
import type {
  AvailableStartupDraft,
  StartupDraftReceipt
} from '../../../../shared/worktree/creation/startup-draft-receipt'
import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'
import { resolveDraftPasteReadyTimeoutMs } from '../../../../shared/agent-launch/startup/readiness/draft-paste-ready-timeout'
import { OrcaRuntimeWithForegroundInspection } from './workspace-foreground-inspection'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../../../shared/workspace/identity/workspace-scope'
import { parseExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeStartupReadinessHost } from './runtime-worktree-startup-readiness'
import { waitForWorktreeSetupGate } from './worktree-setup-gate'
import {
  readPtyFreshComposerHold,
  waitForFreshComposerOnPty,
  type FreshComposerPtyHost
} from '../../terminal/wait/launch-composer-watch'

export abstract class OrcaRuntimeWithWorktreeStartupDrafts extends OrcaRuntimeWithForegroundInspection {
  protected abstract getWorktreeStartupReadinessHost(): WorktreeStartupReadinessHost

  private startupDrafts: WorktreeStartupDrafts | undefined

  private getStartupDrafts(): WorktreeStartupDrafts | undefined {
    if (!this.startupDrafts && this.store?.getProfileStorageDirectory) {
      this.startupDrafts = new WorktreeStartupDrafts(this.store, (drafts) => {
        this.emitClientEvent({ type: 'worktreeStartupDraftsChanged', drafts })
      })
    }
    return this.startupDrafts
  }

  prepareWorktreeStartupDraft(
    worktree: Worktree,
    setup: CreateWorktreeResult['setup'],
    text: unknown
  ): StartupDraftReceipt | undefined {
    if (
      setup?.waitForAgentStartup === true &&
      parseExecutionHostId(worktree.hostId)?.kind !== 'ssh' &&
      typeof text === 'string' &&
      text.trim()
    ) {
      return this.getStartupDrafts()?.prepare(worktree, text)
    }
  }

  listWorktreeStartupDrafts(): AvailableStartupDraft[] {
    return this.getStartupDrafts()?.snapshot() ?? []
  }

  readWorktreeStartupDraft(receipt: StartupDraftReceipt): string | null {
    return this.getStartupDrafts()?.read(receipt) ?? null
  }

  dismissWorktreeStartupDraft(receipt: StartupDraftReceipt): boolean {
    return this.getStartupDrafts()?.dismiss(receipt) ?? false
  }

  waitForWorktreeStartupDraftOutcome(receipt: StartupDraftReceipt) {
    return this.getStartupDrafts()?.wait(receipt) ?? ('unknown' as const)
  }

  releaseUnclaimedWorktreeStartupDraft(receipt: StartupDraftReceipt): null {
    this.getStartupDrafts()?.releaseUnclaimed(receipt)
    return null
  }

  observeStartupDraftGate(
    ptyId: string,
    refusedBeforeSetup = false,
    recoveryOnly = false
  ): Promise<boolean | undefined> {
    const pty = this.ptysById.get(ptyId)
    const drafts = pty && !pty.connectionId ? this.getStartupDrafts() : undefined
    const receipt = pty && drafts?.claimGate(pty.worktreeId, ptyId)
    if (!receipt && recoveryOnly) {
      return Promise.resolve(undefined)
    }
    const settle = (outcome: Parameters<WorktreeStartupDrafts['settle']>[1]): void => {
      if (receipt) {
        drafts?.settle(receipt, outcome)
      }
    }
    if (refusedBeforeSetup) {
      settle('cleared')
      return Promise.resolve(false)
    }
    const signal = this.getPtyLifecycleSignal(ptyId)
    if (signal.aborted) {
      settle('unknown')
      return Promise.resolve(undefined)
    }
    return waitForWorktreeSetupGate(
      this.getWorktreeStartupReadinessHost(),
      ptyId,
      signal,
      receipt
        ? (outcome) =>
            settle(
              outcome === 'blocked' ? 'not-delivered' : outcome === 'failed' ? 'cleared' : outcome
            )
        : undefined
    )
  }

  observeVerifiedReplacementLaunch(ptyId: string, agent: TuiAgent): void {
    const pty = this.ptysById.get(ptyId)
    const drafts = pty && !pty.connectionId ? this.getStartupDrafts() : undefined
    const receipt = pty && drafts?.recoveryForLaunch(pty.worktreeId)
    if (!receipt || !drafts) {
      return
    }
    const lifecycle = this.getPtyLifecycleSignal(ptyId)
    const stop = new AbortController()
    const abort = (): void => stop.abort()
    if (lifecycle.aborted) {
      return
    }
    lifecycle.addEventListener('abort', abort, { once: true })
    void waitForFreshComposerOnPty(
      this.freshComposerPtyHost(),
      ptyId,
      agent,
      resolveDraftPasteReadyTimeoutMs(agent),
      { requireComposerMarker: false, stopOnDialog: false, stop }
    )
      .then((ready) => {
        if (ready && !lifecycle.aborted) {
          drafts.dismiss(receipt)
        }
      })
      .catch(() => console.warn('[worktree-create] could not clear the startup draft'))
      .finally(() => lifecycle.removeEventListener('abort', abort))
  }

  protected clearRecoveredStartupDraft(worktreeId: string): void {
    try {
      const drafts = this.getStartupDrafts()
      const receipt = drafts?.recoveryForLaunch(
        normalizeWorkspaceSessionKeyToWorkspaceId(worktreeId)
      )
      if (receipt) {
        drafts?.dismiss(receipt)
      }
    } catch {
      console.warn('[worktree-create] could not clear the startup draft')
    }
  }

  protected freshComposerPtyHost(): FreshComposerPtyHost {
    return {
      readiness: this.getWorktreeStartupReadinessHost(),
      readForeground: (ptyId, agent) => this.readLaunchedAgentForeground(ptyId, agent),
      readHold: (ptyId) =>
        readPtyFreshComposerHold(this.ptysById.get(ptyId), this.readLiveTerminalScreenLines(ptyId))
    }
  }
}
