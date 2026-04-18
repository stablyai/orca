export declare function collectStaleWorktreePtyIds({ tabsByWorktree, ptyIdsByTabId, codexRestartNoticeByPtyId, worktreeId }: {
    tabsByWorktree: Record<string, {
        id: string;
    }[]>;
    ptyIdsByTabId: Record<string, string[]>;
    codexRestartNoticeByPtyId: Record<string, unknown>;
    worktreeId: string;
}): string[];
export declare function dismissStaleWorktreePtyIds(staleWorktreePtyIds: string[], clearCodexRestartNotice: (ptyId: string) => void): void;
export default function CodexRestartChip({ worktreeId }: {
    worktreeId: string;
}): React.JSX.Element | null;
