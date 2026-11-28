// A teammate's own workspace in a shared agent's Home, read by their devices as the Home itself.
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { OrcaRuntimeWithScheduleMobileSessionTabsChanged } from '../publication/session-tabs-change-publication'
import type { RpcCallerScope } from '../../rpc/callers/rpc-caller-scope'
import type { TabPerson, TeammateTabListKey } from '../../../bots/team-share/teammate-rules'
import {
  holderOfTabList,
  personTabListOf,
  resolveTabListTarget,
  toWireTabList,
  windowOwns
} from './person-workspace-target'
import { findAddressedSessionTab } from '../layout/addressed-session-tab'
import { openEditorFileThroughLayoutOwner } from '../../files/editor-open-through-layout-owner'
import { isSafeMobileRelativePath } from '../../files/mobile-file-kind'
import { joinWorktreeRelativePath } from '../../files/paths/runtime-relative-paths'

export abstract class OrcaRuntimeWithTeammateWorkspaceFrame extends OrcaRuntimeWithScheduleMobileSessionTabsChanged {
  /** A teammate's own workspace as their devices read it: their Home (`toWireTabList`). */
  protected override teammateWorkspaceFrame(
    list: string,
    includeAgentSenders = true,
    projectFor?: { clientNavigationId: string | undefined }
  ): RuntimeMobileSessionTabsResult {
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(list)
    // Read empty, it is published empty, so its first tab moves it to a new version, not a new list.
    const snapshot =
      this.mobileSessionTabsByWorktree.get(list) ??
      this.storeMobileSessionSnapshot(list, {
        ...this.emptyMobileSessionTabsResult(list, 0, false),
        publicationEpoch: `headless:${Date.now().toString(36)}`
      })
    const frame = this.toMobileSessionTabsResult(snapshot)
    const framed = includeAgentSenders ? this.withMobileSessionTabSenders(frame) : frame
    // Its devices' picks are kept by their own workspace, so they apply before it goes out as the Home.
    return toWireTabList(
      projectFor
        ? this.projectMobileSessionTabsForClient(framed, projectFor.clientNavigationId)
        : framed
    ).frame
  }

  /** The stamp a caller's terminal in `worktreeSelector` takes: theirs in their agent's Home. */
  async tabListHolderOf(
    worktreeSelector: string | undefined,
    scope: RpcCallerScope | undefined
  ): Promise<TeammateTabListKey | undefined> {
    if (worktreeSelector === undefined || scope?.kind !== 'bot-share') {
      return undefined
    }
    const selector = await this.tabListSelectorOf(worktreeSelector, scope)
    return selector === worktreeSelector
      ? undefined
      : holderOfTabList(selector.slice('id:'.length)).holder
  }

  /** The selector a caller's tab write on `worktreeSelector` lands in: their own workspace in their
   *  agent's Home (`resolveTabListTarget`), else the one it names. Physical work (files, git, the
   *  terminal's folder) keeps the selector the caller sent. */
  async tabListSelectorOf(
    worktreeSelector: string,
    scope: RpcCallerScope | undefined
  ): Promise<string> {
    if (scope?.kind !== 'bot-share') {
      return worktreeSelector
    }
    const worktreeId =
      this.getExplicitSessionWorktreeIdSelector(worktreeSelector) ??
      (await this.resolveWorkspaceSelector(worktreeSelector)).id
    const { list } = resolveTabListTarget(this.store?.getBots?.() ?? [], worktreeId, scope)
    return list === worktreeId ? worktreeSelector : `id:${list}`
  }

  /** The teammate list a terminal's PTY is stamped with (`holder`), by its handle. */
  terminalHolderOfHandle(handle: string): TeammateTabListKey | undefined {
    const ptyId = this.getTerminalPtyIdForHandle(handle)
    return ptyId ? this.ptysById.get(ptyId)?.holder : undefined
  }

  /** A worker started in `worktreeId` from a teammate's terminal there joins their own workspace. */
  terminalHolderIn(handle: string | undefined, worktreeId: string): TeammateTabListKey | undefined {
    let ptyId: string | null = null
    try {
      ptyId = handle ? this.getTerminalPtyIdForHandle(handle) : null
    } catch {
      // Only a window pane's handle waits on the window's graph, and no window shows a teammate's.
      return undefined
    }
    const pty = ptyId ? this.ptysById.get(ptyId) : undefined
    return pty?.worktreeId === worktreeId ? pty.holder : undefined
  }

  /** A teammate opens a file in their agent's Home: an editor tab of their own workspace, opened the
   *  way a paired server opens one (main's layout), read from disk in the Home. A diff opens as on a
   *  windowless host: not at all. */
  async openTabListFile(
    worktreeSelector: string,
    file: { relativePath: string; mode: 'edit' | 'diff'; oldPath?: string },
    caller: { person: TabPerson; clientNavigationId?: string; activate?: boolean }
  ): Promise<RuntimeMobileSessionTabsResult> {
    const worktree = await this.resolveWorkspaceSelector(worktreeSelector)
    const list = personTabListOf(this.store?.getBots?.() ?? [], worktree.id, caller.person)
    if (windowOwns(list)) {
      // Everyone else opens files in the host's window (`files.open`).
      throw new Error('file_tab_needs_own_list')
    }
    for (const path of [file.relativePath, file.oldPath]) {
      if (path !== undefined && !isSafeMobileRelativePath(path)) {
        throw new Error('invalid_relative_path')
      }
    }
    if (file.mode === 'diff') {
      // As `openDiff` answers on a host with no window (runtime-file-command-state.ts).
      throw new Error('renderer_unavailable')
    }
    const filePath = joinWorktreeRelativePath(worktree.path, file.relativePath)
    await openEditorFileThroughLayoutOwner(
      {
        applyLayoutCommand: (command) => this.applyLayoutCommand(command),
        groupFor: (id) => this.editorOpenGroupFor(id),
        openInWindow: () => {
          throw new Error('renderer_unavailable')
        }
      },
      {
        worktreeId: list,
        filePath,
        relativePath: file.relativePath,
        runtimeEnvironmentId: undefined,
        navigation: 'caller'
      }
    )
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(list, { force: true })
    this.notifyMobileSessionTabsChanged(list)
    const row = this.mobileSessionTabsByWorktree
      .get(list)
      ?.tabs.find(
        (tab) => (tab.type === 'file' || tab.type === 'markdown') && tab.filePath === filePath
      )
    if (row && caller.activate !== false && caller.clientNavigationId) {
      return this.activateMobileSessionTab(`id:${worktree.id}`, row.id, undefined, {
        person: caller.person,
        navigation: 'caller',
        clientNavigationId: caller.clientNavigationId
      })
    }
    return this.listMobileSessionTabs(worktreeSelector, caller.clientNavigationId)
  }

  /** A teammate's activate in their agent's Home picks the tab in their own workspace, answered as
   *  their Home (`toWireTabList`). */
  override async activateMobileSessionTab(
    ...[worktreeSelector, tabId, leafId, opts]: Parameters<
      OrcaRuntimeWithScheduleMobileSessionTabsChanged['activateMobileSessionTab']
    >
  ): ReturnType<OrcaRuntimeWithScheduleMobileSessionTabsChanged['activateMobileSessionTab']> {
    const worktreeId =
      this.getExplicitSessionWorktreeIdSelector(worktreeSelector) ??
      (await this.resolveWorkspaceSelector(worktreeSelector)).id
    const list = personTabListOf(this.store?.getBots?.() ?? [], worktreeId, opts.person)
    const selector = list === worktreeId ? worktreeSelector : `id:${list}`
    return toWireTabList(await super.activateMobileSessionTab(selector, tabId, leafId, opts)).frame
  }

  /** A teammate's own workspace closes its terminals, pages and files as a paired server does; a
   *  chat there, or a tab closed already, goes to its one owner. */
  override async closeMobileSessionTab(
    ...[worktreeSelector, tabId, options]: Parameters<
      OrcaRuntimeWithScheduleMobileSessionTabsChanged['closeMobileSessionTab']
    >
  ): ReturnType<OrcaRuntimeWithScheduleMobileSessionTabsChanged['closeMobileSessionTab']> {
    const named =
      this.getExplicitSessionWorktreeIdSelector(worktreeSelector) ??
      (await this.resolveWorkspaceSelector(worktreeSelector)).id
    const list = personTabListOf(this.store?.getBots?.() ?? [], named, options.person)
    const { holder } = holderOfTabList(list)
    if (!holder) {
      return super.closeMobileSessionTab(worktreeSelector, tabId, options)
    }
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(list)
    const tab = findAddressedSessionTab(this.mobileSessionTabsByWorktree.get(list)?.tabs, tabId)
    return !tab || tab.type === 'agent-session'
      ? this.personChatTabs.closeTeammateTab(holder, named, tabId, options)
      : super.closeMobileSessionTab(`id:${list}`, tabId, options)
  }
}
