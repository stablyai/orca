---
name: orca-chat-visuals
description: Show a chart, diagram, timeline, comparison or UI mockup inline in this Orca chat by writing one self-contained HTML file and adding a visual line to your reply. Use when seeing something would explain the answer faster than prose or a small Markdown table, and only when the ORCA_CHAT_VISUALS_DIR environment variable is set.
user-invocable: false
---

# Inline visuals in an Orca chat

Orca can render an HTML page inside your reply. Reach for it when the reader gains from seeing the
answer: trends, many values side by side, flows, architecture, layouts. Answers that read fine as
text, a short list or a small table don't need one.

## When you can't make one

- This chat's folder is the absolute path in the `ORCA_CHAT_VISUALS_DIR` environment variable. Read
  it from your shell (`printenv ORCA_CHAT_VISUALS_DIR`; in PowerShell `$env:ORCA_CHAT_VISUALS_DIR`).
- If the variable is unset or empty, or writing there fails, don't make a visual.
- Stay inside what the user allowed. In plan or read-only mode don't make a visual. If a write
  there is refused, don't retry it; never switch modes or ask for wider access for a visual.
- Never put visuals in the user's project and never edit `.gitignore` or other files for them.

Without a visual, use a Markdown table, a Mermaid code block or plain prose instead.

## Writing the file

- One visual is one complete HTML document saved directly in that folder (no subfolders).
- Every visual gets a file name not used before in this chat: a few lowercase words and a short
  random suffix, like `latency-by-region-7c1e.html`. Never overwrite or edit an earlier visual;
  write a new file. Allowed: letters, digits, `.`, `_` and `-`; starts with a letter or digit;
  ends in `.html`; at most 128 characters; no `..`; not a Windows device name like `con` or `nul`.
- Put everything in the file: inline `<style>` and `<script>`, data embedded. Keep it under 512 KB.
- Scripts, styles and fonts may load only from `https://cdn.jsdelivr.net`, `https://unpkg.com`,
  `https://cdnjs.cloudflare.com`, `https://esm.sh`, `https://fonts.googleapis.com` and
  `https://fonts.gstatic.com`. Pin library versions.
- The page can't make requests: no `fetch`, `XMLHttpRequest`, `WebSocket` or `EventSource`.
  Images must be inline SVG or `data:` URLs. No forms, popups, nested frames or navigation.
- Fit the width you're given (fluid layout, `max-width: 100%`). Don't size anything to the viewport
  height (`100vh`, `height: 100%` on the page): Orca sizes the frame to your content. Aim for well
  under 1000px tall.
- Match the user's theme with Orca's CSS variables: `--background`, `--foreground`, `--muted`,
  `--muted-foreground`, `--border`, `--primary`, `--accent`, and `--chart-1` to `--chart-5` for data
  series. Leave the page background transparent. When the user switches theme the values change
  and `<html>` gains or loses the `dark` class, with no reload and no event: use the variables from
  CSS or SVG, and redraw a canvas chart when that class changes (a `MutationObserver` on `<html>`).
- Use real text for labels and give the page a heading so it reads without color alone.

## Showing it

Only after the file exists, add this line to your reply on its own line, at the top level (not in
a code block, list, table or quote):

::orca-visual{file="latency-by-region-7c1e.html" title="Latency by region"}

- `file` is the bare file name, never a path. `title` is optional plain text, at most 120
  characters, without `"` or `\`.
- At most 8 visuals in one reply.
- Don't announce the visual or walk through it point by point. Do state the takeaway in a sentence,
  so the reply still makes sense where the visual can't be shown.
