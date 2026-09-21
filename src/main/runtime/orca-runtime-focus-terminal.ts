// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithWaitForLeafPtyId } from './orca-runtime-wait-for-leaf-pty-id'
import type { RuntimeTerminalFocus } from '../../shared/runtime-types'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { getLatestPtyTitle } from './runtime-worktree-status-projection'
import { copySleepingAgentLaunchConfig } from './runtime-agent-launch-resolution'

export class OrcaRuntimeWithFocusTerminal extends OrcaRuntimeWithWaitForLeafPtyId {
  async focusTerminal(
    handle: string,
    options: { navigateHost?: boolean } = {}
  ): Promise<RuntimeTerminalFocus> {
    const navigateHost = options.navigateHost !== false
    const livePtyIdentity = (): RuntimeTerminalFocus => {
      const live = this.getLivePtyForHandle(handle)
      if (!live?.pty.connected) {
        throw new Error('terminal_exited')
      }
      return {
        handle,
        tabId: live.pty.tabId ?? live.record.tabId,
        worktreeId: live.pty.worktreeId,
        navigated: false
      }
    }
    const liveLeafIdentity = (): RuntimeTerminalFocus => {
      this.assertGraphReady()
      const { leaf: current } = this.getLiveLeafForHandle(handle)
      return {
        handle,
        tabId: current.tabId,
        worktreeId: current.worktreeId,
        navigated: false
      }
    }

    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      if (!pty.pty.connected) {
        throw new Error('terminal_exited')
      }
      if (!navigateHost || !this.notifier?.revealTerminalSession) {
        return {
          handle,
          tabId: pty.pty.tabId ?? pty.record.tabId,
          worktreeId: pty.pty.worktreeId,
          navigated: false
        }
      }
      // Coalesce concurrent host navigations: only the latest full reveal claims navigated.
      return this.terminalFocusNavigationCoalescer.run({
        key: handle,
        resolveSuperseded: (completed) =>
          completed ? { ...completed, navigated: false } : livePtyIdentity(),
        run: async (ctx) => {
          const live = this.getLivePtyForHandle(handle)
          if (!live?.pty.connected) {
            throw new Error('terminal_exited')
          }
          if (!ctx.isCurrent()) {
            return {
              handle,
              tabId: live.pty.tabId ?? live.record.tabId,
              worktreeId: live.pty.worktreeId,
              navigated: false
            }
          }
          const notifier = this.notifier
          if (!notifier?.revealTerminalSession) {
            return {
              handle,
              tabId: live.pty.tabId ?? live.record.tabId,
              worktreeId: live.pty.worktreeId,
              navigated: false
            }
          }
          const parsedPaneKey = parsePaneKey(live.pty.paneKey ?? '')
          const revealed = await notifier.revealTerminalSession(live.pty.worktreeId, {
            ptyId: live.pty.ptyId,
            title: getLatestPtyTitle(live.pty),
            ...(live.pty.launchConfig
              ? { launchConfig: copySleepingAgentLaunchConfig(live.pty.launchConfig) }
              : {}),
            ...(live.pty.launchToken ? { launchToken: live.pty.launchToken } : {}),
            ...(live.pty.launchAgent ? { launchAgent: live.pty.launchAgent } : {}),
            ...(live.pty.tabId !== null ? { tabId: live.pty.tabId } : {}),
            ...(parsedPaneKey ? { leafId: parsedPaneKey.leafId } : {})
          })
          if (!ctx.isCurrent() || this.notifier !== notifier) {
            return {
              handle,
              tabId: revealed?.tabId ?? live.pty.tabId ?? live.record.tabId,
              worktreeId: live.pty.worktreeId,
              navigated: false
            }
          }
          return {
            handle,
            tabId: revealed?.tabId ?? live.pty.tabId ?? live.record.tabId,
            worktreeId: live.pty.worktreeId,
            navigated: true
          }
        }
      })
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    if (!navigateHost) {
      return {
        handle,
        tabId: leaf.tabId,
        worktreeId: leaf.worktreeId,
        navigated: false
      }
    }
    if (!this.notifier?.focusTerminal) {
      return {
        handle,
        tabId: leaf.tabId,
        worktreeId: leaf.worktreeId,
        navigated: false
      }
    }
    return this.terminalFocusNavigationCoalescer.run({
      key: handle,
      resolveSuperseded: (completed) =>
        completed ? { ...completed, navigated: false } : liveLeafIdentity(),
      run: async (ctx) => {
        this.assertGraphReady()
        const { leaf: liveLeaf } = this.getLiveLeafForHandle(handle)
        if (!ctx.isCurrent()) {
          return {
            handle,
            tabId: liveLeaf.tabId,
            worktreeId: liveLeaf.worktreeId,
            navigated: false
          }
        }
        const notifier = this.notifier
        if (!notifier?.focusTerminal) {
          return {
            handle,
            tabId: liveLeaf.tabId,
            worktreeId: liveLeaf.worktreeId,
            navigated: false
          }
        }
        notifier.focusTerminal(liveLeaf.tabId, liveLeaf.worktreeId, liveLeaf.leafId)
        if (!ctx.isCurrent() || this.notifier !== notifier) {
          return {
            handle,
            tabId: liveLeaf.tabId,
            worktreeId: liveLeaf.worktreeId,
            navigated: false
          }
        }
        return {
          handle,
          tabId: liveLeaf.tabId,
          worktreeId: liveLeaf.worktreeId,
          navigated: true
        }
      }
    })
  }

  protected getPtyIdsForExplicitTabClose(worktreeId: string, tabId: string): string[] {
    const ptyIds = new Set<string>()
    for (const pty of this.ptysById.values()) {
      if (pty.connected && pty.worktreeId === worktreeId && pty.tabId === tabId) {
        ptyIds.add(pty.ptyId)
      }
    }
    for (const leaf of this.leaves.values()) {
      if (leaf.worktreeId === worktreeId && leaf.tabId === tabId && leaf.ptyId) {
        ptyIds.add(leaf.ptyId)
      }
    }
    return [...ptyIds]
  }
}
