import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { RefreshCw } from 'lucide-react';
import { useMemo } from 'react';
import { useAppStore } from '../store';
export function collectStaleWorktreePtyIds({ tabsByWorktree, ptyIdsByTabId, codexRestartNoticeByPtyId, worktreeId }) {
    return (tabsByWorktree[worktreeId] ?? []).flatMap((tab) => (ptyIdsByTabId[tab.id] ?? []).filter((ptyId) => Boolean(codexRestartNoticeByPtyId[ptyId])));
}
export function dismissStaleWorktreePtyIds(staleWorktreePtyIds, clearCodexRestartNotice) {
    // Why: restart notices are stored per PTY, but the workspace host presents
    // one shared prompt. Clearing all matching PTY notices keeps every pane in
    // that worktree consistent with the dismissal.
    for (const ptyId of staleWorktreePtyIds) {
        clearCodexRestartNotice(ptyId);
    }
}
export default function CodexRestartChip({ worktreeId }) {
    const tabsByWorktree = useAppStore((s) => s.tabsByWorktree);
    const ptyIdsByTabId = useAppStore((s) => s.ptyIdsByTabId);
    const codexRestartNoticeByPtyId = useAppStore((s) => s.codexRestartNoticeByPtyId);
    const queueCodexPaneRestarts = useAppStore((s) => s.queueCodexPaneRestarts);
    const clearCodexRestartNotice = useAppStore((s) => s.clearCodexRestartNotice);
    const staleWorktreePtyIds = useMemo(() => collectStaleWorktreePtyIds({
        tabsByWorktree,
        ptyIdsByTabId,
        codexRestartNoticeByPtyId,
        worktreeId
    }), [codexRestartNoticeByPtyId, ptyIdsByTabId, tabsByWorktree, worktreeId]);
    if (staleWorktreePtyIds.length === 0) {
        return null;
    }
    return (_jsx("div", { className: "pointer-events-none absolute right-3 top-3 z-20", children: _jsxs("div", { className: "pointer-events-auto flex items-center gap-2 rounded-lg border border-border/80 bg-popover/95 px-2 py-1.5 shadow-lg backdrop-blur-sm", children: [_jsx("span", { className: "text-[11px] text-muted-foreground", children: "Codex is using the previous account" }), _jsxs("div", { className: "flex items-center gap-1.5", children: [_jsxs("button", { type: "button", onClick: () => queueCodexPaneRestarts(staleWorktreePtyIds), className: "inline-flex items-center gap-1.5 rounded-md bg-foreground px-2 py-1 text-[11px] font-medium text-background transition-colors hover:opacity-90", children: [_jsx(RefreshCw, { className: "size-3" }), "Restart"] }), _jsx("button", { type: "button", onClick: () => dismissStaleWorktreePtyIds(staleWorktreePtyIds, clearCodexRestartNotice), className: "rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground", children: "Dismiss" })] })] }) }));
}
