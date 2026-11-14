# Theme commands

Use these when the user asks to change how Orca looks: "make my theme warmer", "more contrast in
the sidebar", "a calmer dark theme", "match my terminal". Every change previews live in Orca's
window without touching the user's settings; nothing is kept until `apply`. All commands take
`--json`; branch on `error.code`, not on wording.

```text
ORCA theme show [--resolved] --json
ORCA theme tokens --json
ORCA theme edit [--from current|<theme-id>|<plugin-key>|<dir>|<file.json>] [--name <name>] --json
ORCA theme set <token>=<color>... [--mode light|dark|both] [--unset <token>]... [--patch <json|@file> | --patch-stdin] --json
ORCA theme adjust [--warmth <n>] [--hue <deg>] [--saturation <%>] [--lightness <%>] [--contrast <%>] [--separate <ΔL> [--scope sidebar|tabs|cards|editor]] [--only <prefix,...>] [--mode light|dark|both] --json
ORCA theme check [--fix [--finding <id>]...] --json
ORCA theme undo --json
ORCA theme redo --json
ORCA theme history --json
ORCA theme reset --json
ORCA theme shot [--mode light|dark] [--out <file.png>] --json
ORCA theme apply [--name <name>] --json
ORCA theme discard --json
ORCA theme export <dir> [--name <name>] [--id <plugin-id>] --json
```

## The loop

1. `ORCA theme show --resolved --json` to see what is painted now in each mode, token by token.
2. Make the change. Prefer `adjust` for broad requests (warmer, cooler, brighter, more
   saturated, more contrast) and `set` for named surfaces. "Make the sidebar more distinct" is
   `adjust --separate 0.04` (both sidebars and their hover/selected rows move together, hue
   kept). `--contrast` moves colors away from the background they sit on. `adjust` fixes the
   contrast issues it causes in the same step (`autoFixed`). Change both modes unless the user named
   one: `--mode both` for `set`; `adjust` changes both by default.
3. Read `report` and `paint` in the result. Each finding has an `id`, the `effect` the person
   will see, and up to two `fixes` (smallest change first, lightness only). Apply one with its
   `command` (`ORCA theme check --fix --finding <id>`), all with `ORCA theme check --fix`, or
   `set` your own value. `paint.status` other than `painted` means the screen does not show the
   change yet (`other-variant`: shoot that mode).
4. `ORCA theme shot --mode dark --json` and `--mode light`, then read the PNGs. Look at the result
   before you tell the user it is done.
5. Ask the user whether to keep it. `apply` saves it as one of their themes and switches to it;
   `discard` puts their theme back. The user can also press Keep or Discard in Orca.

## Tokens

- App tokens: `background`, `foreground`, `sidebar` (right sidebar), `worktree-sidebar` (left
  workspace list), `tab-bar`, `tab-active`, `card`, `popover`, `primary`, `accent`, `border`,
  `chat-*`, `diff-*`, `git-decoration-*` and more; `ORCA theme tokens --json` lists all with
  what each paints. Write them without the leading `--` on the command line.
- Terminal colors: `terminal.background`, `terminal.foreground`, `terminal.cursor`,
  `terminal.selectionBackground`, `terminal.black` … `terminal.brightWhite` (hex only).
- Syntax colors: `--patch '{"dark":{"tokenColors":[{"scope":"comment","settings":{"foreground":"#8a7f74","fontStyle":"italic"}}]}}'`.
- Values: hex, `rgb()`, `hsl()` or `oklch()`. `adjust` reports values it cannot read as `skipped`.

## Rules

- Batch: one `set` with several tokens, or `--patch-stdin`, is one step and one repaint. Changes
  are limited to about 3 a second (`rate_limited` gives `retryAfterMs`).
- Pass `--if-revision <revision>` from your last result when another agent may be editing;
  `draft_conflict` means read again first.
- `draft_ended_by_user`: the person pressed Keep or Discard, or picked a theme. Ask before
  starting another draft. `theme_edits_disabled`: they turned agent edits off in Settings.

- Never `apply` unless the user asked to keep the theme, and never `discard` a draft the user
  did not ask you to drop. `undo` steps back one change at a time.
- A draft repaints the user's whole window. Keep edits purposeful; one `adjust` beats twenty
  `set` calls.
- `edit --from <dir|file>` reads theme files as data only. To publish a theme, `export` it to a
  folder and follow `ORCA skills get orca-plugin-authoring`.
- `theme_needs_desktop`: this Orca has no window (a headless server). Run the command where the
  user's Orca desktop app runs.
- `shot --mode` paints the other mode only while Orca's window is hidden or minimized; otherwise
  `themeApplied: false` and the shot shows the mode on screen.
