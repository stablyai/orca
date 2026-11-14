---
name: orca-chat-visuals
description: Show a chart, diagram, table, report or mockup inline in this Orca chat as an HTML
  page. Use when a visual would help the user understand your answer. Only available when the
  ORCA_CHAT_SCRATCH_DIR environment variable is set. For every task, keep reports in
  ORCA_CHAT_SCRATCH_DIR, use ORCA_CHAT_TEMP_DIR for disposable builds/tests, and reuse normal
  package-manager caches instead of private per-task stores.
user-invocable: false
---

# Inline visuals in an Orca chat

Orca can show an HTML page inside your reply. Use one whenever a visual would make the answer
clearer.

## Writing the page

- Save it in the folder named by `ORCA_CHAT_SCRATCH_DIR` (`printenv ORCA_CHAT_SCRATCH_DIR`; in
  PowerShell `$env:ORCA_CHAT_SCRATCH_DIR`). If it's unset or you can't write there, skip the visual.
  This folder belongs to this chat and is kept as long as the chat. Save files meant for the
  project in the workspace. This is persistent artifact storage: do not put dependency installs,
  package caches, source checkouts, build output or test environments here.
- Use `ORCA_CHAT_TEMP_DIR` for disposable build/test data, if set. It may change on agent restart
  and is cleaned after its owning Orca process exits and all files have been unchanged for 7 days.
  Move reports and files the user needs into `ORCA_CHAT_SCRATCH_DIR` before replying. If temporary
  storage is unavailable, use the operating system temporary directory; do not fall back to
  persistent artifact storage for builds. Keep source changes in the workspace or an Orca worktree.
- Reuse the package manager's normal shared cache. Do not create a private `.pnpm-store`, uv cache
  or copied dependency tree per task. Follow the project's existing dependency installation rules.
- One complete HTML file per visual, directly in that folder, under 512 KB, with a new file name
  each time (e.g. `latency-by-region-7c1e.html`): letters, digits, `.`, `_`, `-`, ending in `.html`.
- Inline your styles, scripts and data. Libraries and fonts may load only from cdn.jsdelivr.net,
  unpkg.com, cdnjs.cloudflare.com, esm.sh, fonts.googleapis.com and fonts.gstatic.com. The page
  can't make network requests; use inline SVG or `data:` URLs for images.
- Don't size anything to the viewport height (`100vh`); Orca fits the frame to your content.
- Use Orca's theme variables for surfaces, text, and controls; pair hover `--accent` with
  `--accent-foreground`. Scope fixed-palette CSS to its mockup. Orca updates tokens and
  `color-scheme` live. Charts use `--chart-1` to `--chart-5`.
- Make the saved HTML readable in an ordinary browser too: use paired fallback values such as
  `background:var(--background,#fff);color:var(--foreground,#171717)` for every theme-token use.
  Scripts reading chart colors need a fallback too: `getComputedStyle(document.documentElement)
  .getPropertyValue('--chart-1').trim() || '#2563eb'`. Never redefine Orca's tokens on `:root`:
  those declarations would override the viewer's live theme. Use separate names for local colors.
- Exposed tokens: `--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`,
  `--popover-foreground`, `--primary`, `--primary-foreground`, `--secondary`,
  `--secondary-foreground`, `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`,
  `--destructive`, `--destructive-foreground`, `--border`, `--input`, `--ring`, `--radius`,
  `--font-sans`, `--font-mono`, and `--chart-1` through `--chart-5`.

## Showing it

After the file exists, put this on its own line in your reply, outside any code block:

::orca-visual{file="latency-by-region-7c1e.html" title="Latency by region"}

`file` is the bare file name, never a path; `title` is optional. At most 8 per reply.
