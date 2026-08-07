# Soft-Wrap Selection Copy: "copied command splits into two lines" — Findings & Fix

Date: 2026-08-07
Status: PR-ready

## Reported symptom

Copying an AI-generated command (e.g. `npx skills add … --agent claude-code … -y`)
from a chat/markdown surface and pasting it into a terminal produces a **broken
command**: the wrapped visual line comes out as two real lines, so zsh runs the
second fragment as a separate command and fails with e.g.
`zsh: command not found: code` (the `claude-` / `code` split).

The source text contains **no newline** — the command is one continuous line. The
break is introduced by copy, not by the source.

## Root cause

Copy-paste of soft-wrapped text is **UA-defined** (see `commonmark/commonmark-spec`
issue #744): browsers disagree on whether a visual soft-wrap position becomes a
newline in the copied text.

| Engine | `white-space: pre-wrap` soft wrap | `white-space: normal` (incl. `overflow-wrap`) |
|---|---|---|
| Chromium (Chrome / Edge / Electron / Cursor) | **inserts `\n`** at the wrap point | does not insert `\n` |
| Firefox / Safari (WebKit) | does not insert `\n` | does not insert `\n` |

Orca ships on Chromium (Electron), so any text rendered with
`white-space: pre-wrap` **soft-wraps and copies back with a real `\n`** on the
primary platform. Pasting into a shell then treats the `\n` as a command
separator.

This is **distinct from the terminal-internal path**: `@xterm/xterm` generates
selection text itself (it joins rows by `isWrapped`, only inserting `\r\n`/`\n`
for hard line breaks), so selecting wrapped output inside an Orca terminal does
**not** insert newlines. The bug is confined to DOM-rendered surfaces.

## Affected surfaces in Orca

Any DOM surface that renders command/code-shaped text with `pre-wrap` semantics:

- `src/renderer/src/assets/main.css` — `.orca-diff-comment-body`
  (`white-space: pre-wrap; word-break: break-word`), used by
  `DiffCommentCard.tsx` for AI review comment bodies.
- `src/renderer/src/components/dashboard/DashboardAgentRow.tsx` — agent status
  text (`whitespace-pre-wrap break-words`).
- Command/preview `<pre>` blocks that explicitly opt into
  `whitespace-pre-wrap` (settings/dialogs): `RepositoryHooksSection.tsx`,
  `GitLabItemDialog.tsx`, `NewWorkspaceComposerCard.tsx`,
  `OrcaYamlTrustDialog.tsx`, `AutoRenameFailedDialog.tsx`,
  `AutoRenameBranchFromWorkSetting.tsx`, `PluginVmRecipeConsentPreview.tsx`,
  `PullRequestPage.tsx`.

Markdown code blocks (`CommentMarkdown` compact/document variants,
`.markdown-body pre`) currently render with the UA default
`white-space: pre` (no soft wrap) — **but only by relying on UA defaults**:
neither the components nor `markdown-preview.css` declare `white-space`
explicitly, so any preflight/reset change silently reintroduces the bug.

## Fix

Principle: **code/command-shaped content must never soft-wrap.** It wraps
horizontally (`overflow-x: auto`) instead, matching GitHub/ChatGPT code-block
behavior, so copy never gains synthetic newlines.

1. `src/renderer/src/components/sidebar/comment-markdown-element-renderers.tsx`
   — declare `whitespace-pre` explicitly on the compact `pre` and the
   document `pre` (currently implicit via UA default). This covers agent
   replies in native chat (`CommentMarkdown`).
2. `src/renderer/src/assets/markdown-preview.css` and
   `src/renderer/src/assets/rich-markdown-editor.css` — declare
   `white-space: pre` on `.markdown-body pre` / `.rich-markdown-editor pre`
   (already `overflow-x: auto`).
3. Agent tool output and diffs in native chat —
   `NativeChatToolRun.tsx` (tool stdout/command output) and
   `NativeChatDiffView.tsx` (diff lines; the container switched from
   `overflow-hidden` to `overflow-x-auto overflow-y-hidden`, lines get
   `min-w-max` so add/del backgrounds cover unwrapped text).
4. Command/preview/log `<pre>` blocks elsewhere — drop `whitespace-pre-wrap`
   in favor of `whitespace-pre` (each already has horizontal scroll):
   `RepositoryHooksSection.tsx`, `GitLabItemDialog.tsx`,
   `GitHubItemDialog.tsx` / `PullRequestPage.tsx` / `checks-panel-content.tsx`
   (annotation raw details), `NewWorkspaceComposerCard.tsx`,
   `OrcaYamlTrustDialog.tsx`, `PluginVmRecipeConsentPreview.tsx`,
   `AutoRenameFailedDialog.tsx`, `SkillFreshnessUpdateDialog.tsx`,
   `WorktreeCreationPanel.tsx`, `CheckRunAnnotations.tsx`,
   `check-job-log-tail.tsx`, `source-control-recovery-notice.tsx`,
   `CrashReportDialogSurface.tsx`, `EditorContent.tsx`, `MarkdownPreview.tsx`,
   `IpynbViewer.tsx`.
5. Prose surfaces (`.orca-diff-comment-body`, `DashboardAgentRow`,
   `AutoRenameBranchFromWorkSetting` prompt preview, error notices) keep
   `pre-wrap` — their real newlines are meaningful prose formatting and cannot
   be collapsed without changing semantics; copy of their soft wraps is a
   known Chromium limitation (mitigate via the copy buttons Orca already
   provides, which copy source text directly). `DashboardAgentRowToolStep`
   also stays `pre-wrap` because its `overflow-hidden` is required for the
   row-collapse animation.

## Testing

- Unit: assert the compact/document `pre` renderers emit `whitespace-pre`
  (`comment-markdown-element-renderers.test.tsx`).
- Manual (Chromium/Electron): render a long command in a markdown code block,
  mouse-select across its width, copy, paste — the command must remain one
  line; repeat on a `pre-wrap` command preview to confirm it now scrolls
  horizontally instead of wrapping.
- Manual: verify real multi-line code blocks still copy their hard newlines
  (i.e. only soft wraps are eliminated, hard content is untouched).

## Residual risk

- Prose `pre-wrap` surfaces still split soft wraps on copy under Chromium.
  Fixing them requires either per-surface copy handlers (can't distinguish
  soft vs hard newlines from the clipboard text) or accepting horizontal
  scrolling for prose (rejected: breaks multi-line prose semantics).
- External chat UIs (ChatGPT/Claude/Cursor web) are outside Orca's control;
  the "copy button" path is the reliable workaround there.
