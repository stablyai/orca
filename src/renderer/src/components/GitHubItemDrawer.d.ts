import React from 'react';
import type { GitHubWorkItem } from '../../../shared/types';
type GitHubItemDrawerProps = {
    workItem: GitHubWorkItem | null;
    repoPath: string | null;
    /** Called when the user clicks the primary CTA — same semantics as today's row-click → composer modal. */
    onUse: (item: GitHubWorkItem) => void;
    onClose: () => void;
};
export default function GitHubItemDrawer({ workItem, repoPath, onUse, onClose }: GitHubItemDrawerProps): React.JSX.Element | null;
export {};
