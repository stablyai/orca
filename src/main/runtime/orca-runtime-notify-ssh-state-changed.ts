// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithGetStatus } from './orca-runtime-get-status'
import type { SshConnectionState } from '../../shared/ssh-types'
import { getPublicSshState } from './public-ssh-state'
import { splitWorktreeId } from '../../shared/worktree/id'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import { navigationTargetsClients, navigationTargetsHost } from '../../shared/runtime-navigation'
import { toRuntimeActivateWorktreeEvent } from '../../shared/runtime-client-events'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { BrowserBackend } from '../browser/browser-backend'
import type { EmulatorBridge } from '../emulator/emulator-bridge'

export class OrcaRuntimeWithNotifySshStateChanged extends OrcaRuntimeWithGetStatus {
  // Why: SSH state changes originate in main's ssh handlers, not in runtime
  // methods, so they need a public entry point onto the client-event stream.
  notifySshStateChanged(targetId: string, state: SshConnectionState): void {
    this.bumpSshRelayRecoveryGeneration(targetId)
    this.invalidateSshWorktreeScanCache(targetId)
    if (state.status !== 'connected') {
      this.legacyWorkerRecovery.cancelScope(`ssh:${targetId}`)
    }
    this.emitClientEvent({ type: 'sshStateChanged', targetId, state: getPublicSshState(state)! })
  }

  notifySshRelayReady(targetId: string): void {
    const generation = this.bumpSshRelayRecoveryGeneration(targetId)
    const publish = async (): Promise<void> => {
      try {
        await this.publishRecoveredSshMobileSessionTabs(targetId, generation)
      } catch (error) {
        if (this.sshRelayRecoveryGenerationByTargetId.get(targetId) === generation) {
          console.warn('[runtime] failed to publish recovered SSH session tabs', {
            targetId,
            error
          })
        }
      }
    }
    const initialPublication = publish()
    void initialPublication
    void this.refreshRestoredOrchestrationAuthority(targetId)
      .then(() =>
        this.reconcileLegacyWorkerTerminals({
          connectionId: targetId,
          materializeRenderer: this.notifier !== null
        })
      )
      .then(async () => {
        await initialPublication
        await publish()
      })
      .catch((error) => {
        if (this.sshRelayRecoveryGenerationByTargetId.get(targetId) !== generation) {
          return
        }
        console.warn('[orchestration] legacy worker reconcile failed on relay ready', {
          targetId,
          error
        })
      })
  }

  protected bumpSshRelayRecoveryGeneration(targetId: string): number {
    const generation = (this.sshRelayRecoveryGenerationByTargetId.get(targetId) ?? 0) + 1
    this.sshRelayRecoveryGenerationByTargetId.set(targetId, generation)
    return generation
  }

  protected async publishRecoveredSshMobileSessionTabs(
    targetId: string,
    generation: number
  ): Promise<void> {
    const repoIds = new Set(
      (this.store?.getRepos() ?? [])
        .filter((repo) => repo.connectionId === targetId)
        .map((repo) => repo.id)
    )
    if (repoIds.size === 0) {
      return
    }
    const worktreeIds = new Set<string>()
    for (const worktreeId of [
      ...this.getKnownWorkspaceSessionWorktreeIds(),
      ...this.mobileSessionTabsByWorktree.keys()
    ]) {
      const parsed = splitWorktreeId(worktreeId)
      if (parsed && repoIds.has(parsed.repoId)) {
        worktreeIds.add(worktreeId)
      }
    }
    if (worktreeIds.size === 0) {
      return
    }

    // Why: relay readiness follows PTY reattach; rebuild the HUB-owned panes before paired clients consume the connected event.
    for (const worktreeId of worktreeIds) {
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true
      })
    }
    await this.refreshMobileSessionPtyRecords()
    if (this.sshRelayRecoveryGenerationByTargetId.get(targetId) !== generation) {
      return
    }
    for (const worktreeId of worktreeIds) {
      this.notifyMobileSessionTabsChangedNow(worktreeId, ++this.mobileSessionTabsChangeSequence)
    }
  }

  invalidateSshWorktreeScanCache(targetId: string): void {
    this.invalidateSshWorktreeScanCacheInternal(targetId)
  }

  // Why: renderer-initiated meta updates intentionally skip the renderer
  // notifier (the renderer already applied them optimistically), but remote
  // clients hold no optimistic copy and need the invalidation event.
  notifyWorktreesChangedForRemoteClients(repoId: string): void {
    this.invalidateResolvedWorktreeCache()
    this.emitClientEvent({ type: 'worktreesChanged', repoId })
  }

  // Why: structural catalog changes require a fresh Git scan; renderer metadata edits do not.
  notifyWorktreeCatalogChangedForRemoteClients(repoId: string): void {
    this.invalidateWorktreeScanCacheForRepo(repoId)
    const matchingRepos = this.store?.getRepos().filter((repo) => repo.id === repoId) ?? []
    if (matchingRepos.length !== 1 || matchingRepos[0]?.connectionId) {
      return
    }
    this.notifyWorktreesChangedForRemoteClients(repoId)
  }

  // Why: host-local repo IPC mutations never enter runtime methods, so paired
  // clients need an explicit catalog invalidation; the local renderer already
  // got its own repos:changed and must not be re-notified (#11994).
  notifyReposChangedForRemoteClients(): void {
    this.emitClientEvent({ type: 'reposChanged' })
  }

  protected notifyActivateWorktree(
    repoId: string,
    worktreeId: string,
    setup?: CreateWorktreeResult['setup'],
    startup?: WorktreeStartupLaunch,
    defaultTabs?: CreateWorktreeResult['defaultTabs'],
    navigationTarget?: RuntimeNavigationTarget
  ): void {
    const navigation = navigationTarget ?? 'all'
    if (navigationTargetsHost(navigation)) {
      this.notifyHostActivateWorktree(repoId, worktreeId, setup, startup, defaultTabs)
    }
    if (navigationTargetsClients(navigation)) {
      this.notifyClientsActivateWorktree(repoId, worktreeId, setup, startup, defaultTabs)
    }
  }

  protected notifyHostActivateWorktree(
    repoId: string,
    worktreeId: string,
    setup?: CreateWorktreeResult['setup'],
    startup?: WorktreeStartupLaunch,
    defaultTabs?: CreateWorktreeResult['defaultTabs']
  ): void {
    this.notifier?.activateWorktree(repoId, worktreeId, setup, startup, defaultTabs)
  }

  protected notifyClientsActivateWorktree(
    repoId: string,
    worktreeId: string,
    setup?: CreateWorktreeResult['setup'],
    startup?: WorktreeStartupLaunch,
    defaultTabs?: CreateWorktreeResult['defaultTabs']
  ): void {
    this.emitClientEvent(
      toRuntimeActivateWorktreeEvent(repoId, worktreeId, setup, startup, defaultTabs)
    )
  }

  setAgentBrowserBridge(bridge: AgentBrowserBridge | null): void {
    this.agentBrowserBridge = bridge
  }

  getAgentBrowserBridge(): AgentBrowserBridge | null {
    return this.agentBrowserBridge
  }

  setOffscreenBrowserBackend(backend: BrowserBackend | null): void {
    this.offscreenBrowserBackend = backend
  }

  getOffscreenBrowserBackend(): BrowserBackend | null {
    return this.offscreenBrowserBackend
  }

  setEmulatorBridge(bridge: EmulatorBridge | null): void {
    this.emulatorBridge = bridge
  }

  getEmulatorBridge(): EmulatorBridge | null {
    return this.emulatorBridge
  }
}
