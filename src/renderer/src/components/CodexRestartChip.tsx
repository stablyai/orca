import { RefreshCw } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import { translate } from '@/i18n/i18n'

const EMPTY_TABS: { id: string }[] = []

export function collectStalePtyIdsForTabs({
  tabs,
  ptyIdsByTabId,
  codexRestartNoticeByPtyId
}: {
  tabs: { id: string }[]
  ptyIdsByTabId: Record<string, string[]>
  codexRestartNoticeByPtyId: Record<string, unknown>
}): string[] {
  return tabs.flatMap((tab) =>
    (ptyIdsByTabId[tab.id] ?? []).filter((ptyId) => Boolean(codexRestartNoticeByPtyId[ptyId]))
  )
}

export function collectStaleWorktreePtyIds({
  tabsByWorktree,
  ptyIdsByTabId,
  codexRestartNoticeByPtyId,
  worktreeId
}: {
  tabsByWorktree: Record<string, { id: string }[]>
  ptyIdsByTabId: Record<string, string[]>
  codexRestartNoticeByPtyId: Record<string, unknown>
  worktreeId: string
}): string[] {
  return collectStalePtyIdsForTabs({
    tabs: tabsByWorktree[worktreeId] ?? EMPTY_TABS,
    ptyIdsByTabId,
    codexRestartNoticeByPtyId
  })
}

export function dismissStaleWorktreePtyIds(
  staleWorktreePtyIds: string[],
  clearCodexRestartNotice: (ptyId: string) => void
): void {
  // Why: restart notices are stored per PTY, but the workspace host presents
  // one shared prompt. Clearing all matching PTY notices keeps every pane in
  // that worktree consistent with the dismissal.
  for (const ptyId of staleWorktreePtyIds) {
    clearCodexRestartNotice(ptyId)
  }
}

export default function CodexRestartChip({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const staleWorktreePtyIds = useAppStore(
    useShallow((s) =>
      collectStalePtyIdsForTabs({
        tabs: s.tabsByWorktree[worktreeId] ?? EMPTY_TABS,
        ptyIdsByTabId: s.ptyIdsByTabId,
        codexRestartNoticeByPtyId: s.codexRestartNoticeByPtyId
      })
    )
  )
  const queueCodexPaneRestarts = useAppStore((s) => s.queueCodexPaneRestarts)
  const clearCodexRestartNotice = useAppStore((s) => s.clearCodexRestartNotice)

  if (staleWorktreePtyIds.length === 0) {
    return null
  }

  return (
    <div className="pointer-events-none absolute right-3 top-3 z-20">
      <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border/80 bg-popover/95 px-2 py-1.5 shadow-lg backdrop-blur-sm">
        <span className="text-[11px] text-muted-foreground">
          {translate("auto.components.CodexRestartChip.9263e75f49", "Codex is using the previous account")}</span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => queueCodexPaneRestarts(staleWorktreePtyIds)}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-2 py-1 text-[11px] font-medium text-background transition-colors hover:opacity-90"
          >
            <RefreshCw className="size-3" />
            {translate("auto.components.CodexRestartChip.c72a5fb234", "Restart")}</button>
          <button
            type="button"
            onClick={() => dismissStaleWorktreePtyIds(staleWorktreePtyIds, clearCodexRestartNotice)}
            className="rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            {translate("auto.components.CodexRestartChip.9132779820", "Dismiss")}</button>
        </div>
      </div>
    </div>
  )
}
