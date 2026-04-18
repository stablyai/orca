import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
/* eslint-disable max-lines -- Why: the GH drawer keeps its header, conversation, files, and checks tabs co-located so the read-only PR/Issue surface stays in one place while this view evolves. */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, CircleDashed, CircleDot, ExternalLink, FileText, GitPullRequest, LoaderCircle, MessageSquare, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import CommentMarkdown from '@/components/sidebar/CommentMarkdown';
import { useSidebarResize } from '@/hooks/useSidebarResize';
import { detectLanguage } from '@/lib/language-detect';
import { cn } from '@/lib/utils';
import { CHECK_COLOR, CHECK_ICON } from '@/components/right-sidebar/checks-helpers';
// Why: the editor's DiffViewer loads Monaco, which is heavy and should not be
// pulled into the drawer's bundle until the user actually opens the Files tab.
const DiffViewer = lazy(() => import('@/components/editor/DiffViewer'));
const DRAWER_MIN_WIDTH = 420;
const DRAWER_MAX_WIDTH = 920;
const DRAWER_DEFAULT_WIDTH = 560;
function formatRelativeTime(input) {
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) {
        return 'recently';
    }
    const diffMs = date.getTime() - Date.now();
    const diffMinutes = Math.round(diffMs / 60_000);
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    if (Math.abs(diffMinutes) < 60) {
        return formatter.format(diffMinutes, 'minute');
    }
    const diffHours = Math.round(diffMinutes / 60);
    if (Math.abs(diffHours) < 24) {
        return formatter.format(diffHours, 'hour');
    }
    const diffDays = Math.round(diffHours / 24);
    return formatter.format(diffDays, 'day');
}
function getStateLabel(item) {
    if (item.type === 'pr') {
        if (item.state === 'merged') {
            return 'Merged';
        }
        if (item.state === 'draft') {
            return 'Draft';
        }
        if (item.state === 'closed') {
            return 'Closed';
        }
        return 'Open';
    }
    return item.state === 'closed' ? 'Closed' : 'Open';
}
function getStateTone(item) {
    if (item.type === 'pr') {
        if (item.state === 'merged') {
            return 'border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-300';
        }
        if (item.state === 'draft') {
            return 'border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300';
        }
        if (item.state === 'closed') {
            return 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300';
        }
        return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300';
    }
    if (item.state === 'closed') {
        return 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300';
    }
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300';
}
function fileStatusTone(status) {
    switch (status) {
        case 'added':
            return 'text-emerald-500';
        case 'removed':
            return 'text-rose-500';
        case 'renamed':
        case 'copied':
            return 'text-sky-500';
        default:
            return 'text-amber-500';
    }
}
function fileStatusLabel(status) {
    switch (status) {
        case 'added':
            return 'A';
        case 'removed':
            return 'D';
        case 'renamed':
            return 'R';
        case 'copied':
            return 'C';
        case 'unchanged':
            return '·';
        default:
            return 'M';
    }
}
function PRFileRow({ file, repoPath, prNumber, headSha, baseSha }) {
    const [expanded, setExpanded] = useState(false);
    const [contents, setContents] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const canLoadDiff = Boolean(headSha && baseSha) && !file.isBinary;
    const handleToggle = useCallback(() => {
        setExpanded((prev) => {
            const next = !prev;
            if (next && !contents && !loading && canLoadDiff && headSha && baseSha) {
                setLoading(true);
                setError(null);
                window.api.gh
                    .prFileContents({
                    repoPath,
                    prNumber,
                    path: file.path,
                    oldPath: file.oldPath,
                    status: file.status,
                    headSha,
                    baseSha
                })
                    .then((result) => {
                    setContents(result);
                })
                    .catch((err) => {
                    setError(err instanceof Error ? err.message : 'Failed to load diff');
                })
                    .finally(() => {
                    setLoading(false);
                });
            }
            return next;
        });
    }, [
        baseSha,
        canLoadDiff,
        contents,
        file.oldPath,
        file.path,
        file.status,
        headSha,
        loading,
        prNumber,
        repoPath
    ]);
    const language = useMemo(() => detectLanguage(file.path), [file.path]);
    const modelKey = `gh-drawer:pr:${prNumber}:${file.path}`;
    return (_jsxs("div", { className: "border-b border-border/50", children: [_jsxs("button", { type: "button", onClick: handleToggle, className: "flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-muted/40", children: [expanded ? (_jsx(ChevronDown, { className: "size-3.5 shrink-0 text-muted-foreground" })) : (_jsx(ChevronRight, { className: "size-3.5 shrink-0 text-muted-foreground" })), _jsx("span", { className: cn('inline-flex size-5 shrink-0 items-center justify-center rounded border border-border/60 font-mono text-[10px]', fileStatusTone(file.status)), "aria-label": file.status, children: fileStatusLabel(file.status) }), _jsx("span", { className: "min-w-0 flex-1 truncate font-mono text-[12px] text-foreground", children: file.oldPath && file.oldPath !== file.path ? (_jsxs(_Fragment, { children: [_jsx("span", { className: "text-muted-foreground", children: file.oldPath }), _jsx("span", { className: "mx-1 text-muted-foreground", children: "\u2192" }), file.path] })) : (file.path) }), _jsxs("span", { className: "shrink-0 font-mono text-[11px] text-muted-foreground", children: [_jsxs("span", { className: "text-emerald-500", children: ["+", file.additions] }), _jsx("span", { className: "mx-1", children: "/" }), _jsxs("span", { className: "text-rose-500", children: ["\u2212", file.deletions] })] })] }), expanded && (
            // Why: DiffViewer's inner layout uses flex-1/min-h-0, so this wrapper
            // must be a flex column with a fixed height for Monaco to size itself
            // correctly. A plain block div collapses flex-1 to 0 and renders empty.
            _jsx("div", { className: "flex h-[420px] flex-col border-t border-border/40 bg-background", children: !canLoadDiff ? (_jsx("div", { className: "flex h-full items-center justify-center px-4 text-center text-[12px] text-muted-foreground", children: file.isBinary
                        ? 'Binary file — diff not shown.'
                        : 'Diff unavailable (missing commit SHAs).' })) : loading ? (_jsx("div", { className: "flex h-full items-center justify-center", children: _jsx(LoaderCircle, { className: "size-5 animate-spin text-muted-foreground" }) })) : error ? (_jsx("div", { className: "flex h-full items-center justify-center px-4 text-center text-[12px] text-destructive", children: error })) : contents ? (contents.originalIsBinary || contents.modifiedIsBinary ? (_jsx("div", { className: "flex h-full items-center justify-center px-4 text-center text-[12px] text-muted-foreground", children: "Binary file \u2014 diff not shown." })) : (_jsx(Suspense, { fallback: _jsx("div", { className: "flex h-full items-center justify-center", children: _jsx(LoaderCircle, { className: "size-5 animate-spin text-muted-foreground" }) }), children: _jsx(DiffViewer, { modelKey: modelKey, originalContent: contents.original, modifiedContent: contents.modified, language: language, filePath: file.path, relativePath: file.path, sideBySide: false }) }))) : null }))] }));
}
function ConversationTab({ item, body, comments, loading }) {
    const authorLabel = item.author ?? 'unknown';
    return (_jsxs("div", { className: "flex flex-col gap-4 px-4 py-4", children: [_jsxs("div", { className: "rounded-lg border border-border/50 bg-background/40", children: [_jsxs("div", { className: "flex items-center gap-2 border-b border-border/50 px-3 py-2 text-[12px] text-muted-foreground", children: [_jsx("span", { className: "font-medium text-foreground", children: authorLabel }), _jsxs("span", { children: ["\u00B7 ", formatRelativeTime(item.updatedAt)] })] }), _jsx("div", { className: "px-3 py-3 text-[14px] leading-relaxed text-foreground", children: body.trim() ? (_jsx(CommentMarkdown, { content: body, className: "text-[14px] leading-relaxed" })) : (_jsx("span", { className: "italic text-muted-foreground", children: "No description provided." })) })] }), _jsxs("div", { className: "flex items-center gap-2 pt-1", children: [_jsx(MessageSquare, { className: "size-4 text-muted-foreground" }), _jsx("span", { className: "text-[13px] font-medium text-foreground", children: "Comments" }), comments.length > 0 && (_jsx("span", { className: "text-[12px] text-muted-foreground", children: comments.length }))] }), loading && comments.length === 0 ? (_jsx("div", { className: "flex items-center justify-center py-6", children: _jsx(LoaderCircle, { className: "size-4 animate-spin text-muted-foreground" }) })) : comments.length === 0 ? (_jsx("p", { className: "text-[13px] text-muted-foreground", children: "No comments yet." })) : (_jsx("div", { className: "flex flex-col gap-3", children: comments.map((comment) => (_jsxs("div", { className: "rounded-lg border border-border/40 bg-background/30", children: [_jsxs("div", { className: "flex items-center gap-2 border-b border-border/40 px-3 py-2", children: [comment.authorAvatarUrl ? (_jsx("img", { src: comment.authorAvatarUrl, alt: comment.author, className: "size-5 shrink-0 rounded-full" })) : (_jsx("div", { className: "size-5 shrink-0 rounded-full bg-muted" })), _jsx("span", { className: "text-[13px] font-semibold text-foreground", children: comment.author }), _jsxs("span", { className: "text-[12px] text-muted-foreground", children: ["\u00B7 ", formatRelativeTime(comment.createdAt)] }), comment.path && (_jsxs("span", { className: "font-mono text-[11px] text-muted-foreground/70", children: [comment.path.split('/').pop(), comment.line ? `:L${comment.line}` : ''] })), comment.isResolved && (_jsx("span", { className: "rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground", children: "resolved" })), _jsx("div", { className: "ml-auto", children: comment.url && (_jsx("button", { type: "button", onClick: () => window.api.shell.openUrl(comment.url), className: "text-muted-foreground/60 hover:text-foreground", "aria-label": "Open comment on GitHub", children: _jsx(ExternalLink, { className: "size-3.5" }) })) })] }), _jsx("div", { className: "px-3 py-2", children: _jsx(CommentMarkdown, { content: comment.body, className: "text-[13px] leading-relaxed" }) })] }, comment.id))) }))] }));
}
function ChecksTab({ checks, loading }) {
    const list = checks ?? [];
    if (loading && list.length === 0) {
        return (_jsx("div", { className: "flex items-center justify-center py-10", children: _jsx(LoaderCircle, { className: "size-5 animate-spin text-muted-foreground" }) }));
    }
    if (list.length === 0) {
        return (_jsx("div", { className: "px-4 py-10 text-center text-[12px] text-muted-foreground", children: "No checks configured." }));
    }
    return (_jsx("div", { className: "px-2 py-2", children: list.map((check) => {
            const conclusion = check.conclusion ?? 'pending';
            const Icon = CHECK_ICON[conclusion] ?? CircleDashed;
            const color = CHECK_COLOR[conclusion] ?? 'text-muted-foreground';
            return (_jsxs("button", { type: "button", onClick: () => {
                    if (check.url) {
                        window.api.shell.openUrl(check.url);
                    }
                }, className: cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition', check.url ? 'hover:bg-muted/40' : ''), children: [_jsx(Icon, { className: cn('size-3.5 shrink-0', color, conclusion === 'pending' && 'animate-spin') }), _jsx("span", { className: "flex-1 truncate text-[12px] text-foreground", children: check.name }), check.url && _jsx(ExternalLink, { className: "size-3 shrink-0 text-muted-foreground/40" })] }, check.name));
        }) }));
}
export default function GitHubItemDrawer({ workItem, repoPath, onUse, onClose }) {
    const [width, setWidth] = useState(DRAWER_DEFAULT_WIDTH);
    const [tab, setTab] = useState('conversation');
    const [details, setDetails] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const { containerRef, isResizing, onResizeStart } = useSidebarResize({
        isOpen: workItem !== null,
        width,
        minWidth: DRAWER_MIN_WIDTH,
        maxWidth: DRAWER_MAX_WIDTH,
        deltaSign: -1,
        setWidth
    });
    const requestIdRef = useRef(0);
    useEffect(() => {
        if (!workItem || !repoPath) {
            setDetails(null);
            setError(null);
            return;
        }
        // Why: if the user clicks through several rows quickly, discard stale
        // responses by tagging each request with a monotonic id and only applying
        // results whose id matches the latest one.
        requestIdRef.current += 1;
        const requestId = requestIdRef.current;
        setLoading(true);
        setError(null);
        setDetails(null);
        setTab('conversation');
        window.api.gh
            .workItemDetails({ repoPath, number: workItem.number })
            .then((result) => {
            if (requestId !== requestIdRef.current) {
                return;
            }
            setDetails(result);
        })
            .catch((err) => {
            if (requestId !== requestIdRef.current) {
                return;
            }
            setError(err instanceof Error ? err.message : 'Failed to load details');
        })
            .finally(() => {
            if (requestId !== requestIdRef.current) {
                return;
            }
            setLoading(false);
        });
    }, [repoPath, workItem]);
    useEffect(() => {
        if (!workItem) {
            return;
        }
        const handler = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [onClose, workItem]);
    if (!workItem) {
        return null;
    }
    const Icon = workItem.type === 'pr' ? GitPullRequest : CircleDot;
    const body = details?.body ?? '';
    const comments = details?.comments ?? [];
    const files = details?.files ?? [];
    const checks = details?.checks ?? [];
    return (_jsxs("div", { ref: containerRef, style: { width: `${width}px` }, className: cn('relative flex h-full shrink-0 flex-col border-l border-border/60 bg-card shadow-xl', isResizing && 'select-none'), children: [_jsx("div", { onMouseDown: onResizeStart, className: "absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize bg-transparent hover:bg-primary/40", role: "separator", "aria-orientation": "vertical", "aria-label": "Resize drawer" }), _jsx("div", { className: "flex-none border-b border-border/60 px-4 py-3", children: _jsxs("div", { className: "flex items-start gap-2", children: [_jsx(Icon, { className: "mt-1 size-4 shrink-0 text-muted-foreground" }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', getStateTone(workItem)), children: getStateLabel(workItem) }), _jsxs("span", { className: "font-mono text-[12px] text-muted-foreground", children: ["#", workItem.number] })] }), _jsx("h2", { className: "mt-1 text-[15px] font-semibold leading-tight text-foreground", children: workItem.title }), _jsxs("div", { className: "mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground", children: [_jsx("span", { children: workItem.author ?? 'unknown' }), _jsxs("span", { children: ["\u00B7 ", formatRelativeTime(workItem.updatedAt)] }), workItem.branchName && (_jsxs("span", { className: "font-mono text-[10px] text-muted-foreground/80", children: ["\u00B7 ", workItem.branchName] }))] }), workItem.labels.length > 0 && (_jsx("div", { className: "mt-2 flex flex-wrap gap-1", children: workItem.labels.map((label) => (_jsx("span", { className: "rounded-full border border-border/50 bg-background/60 px-2 py-0.5 text-[10px] text-muted-foreground", children: label }, label))) }))] }), _jsxs("div", { className: "flex shrink-0 items-center gap-1", children: [_jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx(Button, { variant: "ghost", size: "icon", className: "size-7", onClick: () => window.api.shell.openUrl(workItem.url), "aria-label": "Open on GitHub", children: _jsx(ExternalLink, { className: "size-4" }) }) }), _jsx(TooltipContent, { side: "bottom", sideOffset: 6, children: "Open on GitHub" })] }), _jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx(Button, { variant: "ghost", size: "icon", className: "size-7", onClick: onClose, "aria-label": "Close drawer", children: _jsx(X, { className: "size-4" }) }) }), _jsx(TooltipContent, { side: "bottom", sideOffset: 6, children: "Close \u00B7 Esc" })] })] })] }) }), _jsx("div", { className: "min-h-0 flex-1", children: error ? (_jsx("div", { className: "px-4 py-6 text-[12px] text-destructive", children: error })) : (_jsxs(Tabs, { value: tab, onValueChange: (value) => setTab(value), className: "flex h-full min-h-0 flex-col gap-0", children: [_jsxs(TabsList, { variant: "line", className: "mx-4 mt-2 justify-start gap-3 border-b border-border/60", children: [_jsxs(TabsTrigger, { value: "conversation", className: "px-2", children: [_jsx(MessageSquare, { className: "size-3.5" }), "Conversation"] }), workItem.type === 'pr' && (_jsxs(_Fragment, { children: [_jsxs(TabsTrigger, { value: "files", className: "px-2", children: [_jsx(FileText, { className: "size-3.5" }), "Files", files.length > 0 && (_jsx("span", { className: "ml-1 text-[10px] text-muted-foreground", children: files.length }))] }), _jsxs(TabsTrigger, { value: "checks", className: "px-2", children: ["Checks", checks.length > 0 && (_jsx("span", { className: "ml-1 text-[10px] text-muted-foreground", children: checks.length }))] })] }))] }), _jsxs("div", { className: "min-h-0 flex-1 overflow-y-auto scrollbar-sleek", children: [_jsx(TabsContent, { value: "conversation", className: "mt-0", children: _jsx(ConversationTab, { item: workItem, body: body, comments: comments, loading: loading }) }), workItem.type === 'pr' && (_jsx(TabsContent, { value: "files", className: "mt-0", children: loading && files.length === 0 ? (_jsx("div", { className: "flex items-center justify-center py-10", children: _jsx(LoaderCircle, { className: "size-5 animate-spin text-muted-foreground" }) })) : files.length === 0 ? (_jsx("div", { className: "px-4 py-10 text-center text-[12px] text-muted-foreground", children: "No files changed." })) : (_jsx("div", { children: files.map((file) => (_jsx(PRFileRow, { file: file, repoPath: repoPath ?? '', prNumber: workItem.number, headSha: details?.headSha, baseSha: details?.baseSha }, file.path))) })) })), workItem.type === 'pr' && (_jsx(TabsContent, { value: "checks", className: "mt-0", children: _jsx(ChecksTab, { checks: checks, loading: loading }) }))] })] })) }), _jsx("div", { className: "flex-none border-t border-border/60 bg-background/40 px-4 py-3", children: _jsxs(Button, { onClick: () => onUse(workItem), className: "w-full justify-center gap-2", "aria-label": `Start workspace from ${workItem.type === 'pr' ? 'PR' : 'issue'}`, children: [`Start workspace from ${workItem.type === 'pr' ? 'PR' : 'issue'}`, _jsx(ArrowRight, { className: "size-4" })] }) })] }));
}
