import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ExternalLink, FolderPlus, GitBranchPlus, Star } from 'lucide-react';
import { cn } from '../lib/utils';
import { useAppStore } from '../store';
import { isGitRepoKind } from '../../../shared/repo-kind';
import { getTaskPresetQuery } from '../lib/new-workspace';
import { ShortcutKeyCombo } from './ShortcutKeyCombo';
import logo from '../../../../resources/logo.svg';
function getPreflightIssues(status) {
    const issues = [];
    if (!status.git.installed) {
        issues.push({
            id: 'git',
            title: 'Git is not installed',
            description: 'Git is required for Git repositories, source control, and worktree management.',
            fixLabel: 'Install Git',
            fixUrl: 'https://git-scm.com/downloads'
        });
    }
    if (!status.gh.installed) {
        issues.push({
            id: 'gh',
            title: 'GitHub CLI is not installed',
            description: 'Orca uses the GitHub CLI (gh) to show pull requests, issues, and checks.',
            fixLabel: 'Install GitHub CLI',
            fixUrl: 'https://cli.github.com'
        });
    }
    else if (!status.gh.authenticated) {
        issues.push({
            id: 'gh-auth',
            title: 'GitHub CLI is not authenticated',
            description: 'Run "gh auth login" in a terminal to connect your GitHub account.',
            fixLabel: 'Learn more',
            fixUrl: 'https://cli.github.com/manual/gh_auth_login'
        });
    }
    return issues;
}
function GitHubStarButton({ hasRepos }) {
    const [state, setState] = useState('loading');
    useEffect(() => {
        let cancelled = false;
        void window.api.gh.checkOrcaStarred().then((result) => {
            if (cancelled) {
                return;
            }
            if (result === null) {
                setState('hidden');
            }
            else {
                setState(result ? 'starred' : 'not-starred');
            }
        });
        return () => {
            cancelled = true;
        };
    }, []);
    const handleClick = async () => {
        if (state !== 'not-starred') {
            return;
        }
        setState('starred'); // optimistic
        const ok = await window.api.gh.starOrca();
        if (!ok) {
            setState('not-starred');
        }
    };
    // Hide if gh CLI is unavailable, or if the user has already starred and added a repo
    if (state === 'hidden' || (state === 'starred' && hasRepos)) {
        return null;
    }
    return (_jsxs("button", { className: cn('inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-[13px] font-medium transition-all duration-300', state === 'loading' && 'pointer-events-none opacity-0', state === 'not-starred' &&
            'border-amber-400/30 text-amber-300/90 hover:border-amber-400/50 hover:bg-amber-400/[0.08] cursor-pointer', state === 'starred' && 'border-amber-400/25 bg-amber-400/[0.06] text-amber-400/60'), onClick: handleClick, disabled: state === 'starred' || state === 'loading', children: [_jsx(Star, { className: cn('size-3.5 transition-all duration-300', state === 'starred' ? 'fill-amber-400/60 text-amber-400/60' : 'text-amber-400/80') }), state === 'starred' ? 'Starred on GitHub' : 'Star on GitHub'] }));
}
function PreflightBanner({ issues }) {
    return (_jsxs("div", { className: "w-full rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4 space-y-3", children: [_jsxs("div", { className: "flex items-center gap-2 text-yellow-500", children: [_jsx(AlertTriangle, { className: "size-4 shrink-0" }), _jsx("span", { className: "text-sm font-medium", children: "Missing dependencies" })] }), _jsx("div", { className: "space-y-2.5", children: issues.map((issue) => (_jsxs("div", { className: "flex items-start justify-between gap-3", children: [_jsxs("div", { className: "min-w-0", children: [_jsx("p", { className: "text-sm font-medium text-foreground", children: issue.title }), _jsx("p", { className: "text-xs text-muted-foreground mt-0.5", children: issue.description })] }), _jsxs("button", { className: "inline-flex items-center gap-1 shrink-0 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors cursor-pointer", onClick: () => window.api.shell.openUrl(issue.fixUrl), children: [issue.fixLabel, _jsx(ExternalLink, { className: "size-3" })] })] }, issue.id))) })] }));
}
export default function Landing() {
    const repos = useAppStore((s) => s.repos);
    const openNewWorkspacePage = useAppStore((s) => s.openNewWorkspacePage);
    const openModal = useAppStore((s) => s.openModal);
    const prefetchWorkItems = useAppStore((s) => s.prefetchWorkItems);
    const defaultTaskViewPreset = useAppStore((s) => s.settings?.defaultTaskViewPreset ?? 'all');
    const canCreateWorktree = repos.some((repo) => isGitRepoKind(repo));
    // Why: warm the exact cache key NewWorkspacePage will read on mount — the
    // default-preset query must match or the page pays a full round-trip after
    // click.
    const handlePrefetchNewWorkspace = () => {
        if (!canCreateWorktree) {
            return;
        }
        const firstGit = repos.find((r) => isGitRepoKind(r));
        if (firstGit?.path) {
            prefetchWorkItems(firstGit.path, 36, getTaskPresetQuery(defaultTaskViewPreset));
        }
    };
    const [preflightIssues, setPreflightIssues] = useState([]);
    useEffect(() => {
        let cancelled = false;
        const refreshPreflight = (force = false) => {
            void window.api.preflight.check(force ? { force: true } : undefined).then((status) => {
                if (cancelled) {
                    return;
                }
                setPreflightIssues(getPreflightIssues(status));
            });
        };
        refreshPreflight();
        // Why: users often install/authenticate gh outside Orca. Re-check when the
        // window becomes active again so the landing warning clears without relaunch.
        const handleWindowActive = () => {
            if (document.visibilityState === 'visible') {
                refreshPreflight(true);
            }
        };
        document.addEventListener('visibilitychange', handleWindowActive);
        window.addEventListener('focus', handleWindowActive);
        return () => {
            cancelled = true;
            document.removeEventListener('visibilitychange', handleWindowActive);
            window.removeEventListener('focus', handleWindowActive);
        };
    }, []);
    useEffect(() => {
        if (preflightIssues.length === 0) {
            return;
        }
        // Why: some users complete `gh auth login` without ever leaving the Orca
        // window. Poll only while a warning is visible so the banner self-clears.
        const intervalId = window.setInterval(() => {
            void window.api.preflight.check({ force: true }).then((status) => {
                setPreflightIssues(getPreflightIssues(status));
            });
        }, 30000);
        return () => window.clearInterval(intervalId);
    }, [preflightIssues.length]);
    const shortcuts = useMemo(() => {
        // Use platform-appropriate modifier key labels so Windows users see Ctrl/Shift
        // rather than the Mac-only ⌘/⇧ symbols.
        const isMac = navigator.userAgent.includes('Mac');
        const mod = isMac ? '⌘' : 'Ctrl';
        const shift = isMac ? '⇧' : 'Shift';
        return [
            { id: 'create', keys: [mod, 'N'], action: 'Create worktree' },
            { id: 'up', keys: [mod, shift, '↑'], action: 'Move up worktree' },
            { id: 'down', keys: [mod, shift, '↓'], action: 'Move down worktree' }
        ];
    }, []);
    return (_jsxs("div", { className: "absolute inset-0 flex items-center justify-center bg-background", children: [_jsx("div", { className: "w-full max-w-lg px-6", children: _jsxs("div", { className: "flex flex-col items-center gap-4 py-8", children: [_jsx("div", { className: "flex items-center justify-center size-20 rounded-2xl border border-border/80 shadow-lg shadow-black/40", style: { backgroundColor: '#12181e' }, children: _jsx("img", { src: logo, alt: "Orca logo", className: "size-12" }) }), _jsx("h1", { className: "text-4xl font-bold text-foreground tracking-tight", children: "ORCA" }), preflightIssues.length > 0 && _jsx(PreflightBanner, { issues: preflightIssues }), _jsx("p", { className: "text-sm text-muted-foreground text-center", children: canCreateWorktree
                                ? 'Select a worktree from the sidebar to begin.'
                                : 'Add a repository to get started.' }), _jsxs("div", { className: "flex items-center justify-center gap-2.5 flex-wrap", children: [_jsxs("button", { className: "inline-flex items-center gap-1.5 bg-secondary/70 border border-border/80 text-foreground font-medium text-sm px-4 py-2 rounded-md cursor-pointer hover:bg-accent transition-colors", onClick: () => openModal('add-repo'), children: [_jsx(FolderPlus, { className: "size-3.5" }), "Add Repo"] }), _jsxs("button", { className: "inline-flex items-center gap-1.5 bg-secondary/70 border border-border/80 text-foreground font-medium text-sm px-4 py-2 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed enabled:cursor-pointer enabled:hover:bg-accent", disabled: !canCreateWorktree, title: !canCreateWorktree ? 'Add a Git repo first' : undefined, onClick: () => openNewWorkspacePage(), onPointerEnter: handlePrefetchNewWorkspace, onFocus: handlePrefetchNewWorkspace, children: [_jsx(GitBranchPlus, { className: "size-3.5" }), "Create Worktree"] })] }), _jsx("div", { className: "mt-6 w-full max-w-xs space-y-2", children: shortcuts.map((shortcut) => (_jsxs("div", { className: "grid grid-cols-[1fr_auto] items-center gap-3", children: [_jsx("span", { className: "text-sm text-muted-foreground", children: shortcut.action }), _jsx(ShortcutKeyCombo, { keys: shortcut.keys, separatorClassName: "mx-0.5 text-[10px] text-muted-foreground" })] }, shortcut.id))) })] }) }), _jsx("div", { className: "absolute bottom-6 left-0 right-0 flex justify-center", children: _jsx(GitHubStarButton, { hasRepos: repos.length > 0 }) })] }));
}
