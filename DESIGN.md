---
version: alpha
name: Orca
description: >-
  Visual identity for Orca, a desktop AI-orchestration IDE for running Claude
  Code, Codex, and other CLI agents side-by-side across git worktrees. Tokens
  describe the default (light) theme; a parallel dark theme is documented in
  prose.
colors:
  background: "#ffffff"
  foreground: "#0a0a0a"
  card: "#ffffff"
  card-foreground: "#0a0a0a"
  popover: "#ffffff"
  popover-foreground: "#0a0a0a"
  primary: "#171717"
  primary-foreground: "#fafafa"
  secondary: "#f5f5f5"
  secondary-foreground: "#171717"
  muted: "#f5f5f5"
  muted-foreground: "#6B6B6B"
  accent: "#f5f5f5"
  accent-foreground: "#171717"
  destructive: "#e40014"
  destructive-foreground: "#fcf3f3"
  border: "#e5e5e5"
  input: "#e5e5e5"
  ring: "#8E8E8E"
  sidebar: "#fafafa"
  sidebar-foreground: "#0a0a0a"
  sidebar-primary: "#171717"
  sidebar-primary-foreground: "#fafafa"
  sidebar-accent: "#f5f5f5"
  sidebar-accent-foreground: "#171717"
  sidebar-border: "#e5e5e5"
  sidebar-ring: "#a1a1a1"
  editor-surface: "#ffffff"
  git-added: "#587c0c"
  git-modified: "#895503"
  git-deleted: "#ad0707"
  git-renamed: "#007acc"
  git-untracked: "#007100"
  agent-active: "#16a34a"
# Why: parallel dark-theme remap keyed by the same semantic token names.
# Not part of the official DESIGN.md alpha schema, but included so a build
# script can emit CSS variables for `.dark` without re-parsing the prose.
dark-colors:
  background: "#0a0a0a"
  foreground: "#fafafa"
  card: "#171717"
  card-foreground: "#fafafa"
  popover: "#171717"
  popover-foreground: "#fafafa"
  primary: "#e5e5e5"
  primary-foreground: "#171717"
  secondary: "#262626"
  secondary-foreground: "#fafafa"
  muted: "#262626"
  muted-foreground: "#a1a1a1"
  accent: "#404040"
  accent-foreground: "#fafafa"
  destructive: "#ff6568"
  destructive-foreground: "#df2225"
  border: "rgba(255, 255, 255, 0.07)"
  input: "rgba(255, 255, 255, 0.15)"
  ring: "#737373"
  sidebar: "#171717"
  sidebar-foreground: "#fafafa"
  sidebar-primary: "#1447e6"
  sidebar-primary-foreground: "#fafafa"
  sidebar-accent: "#262626"
  sidebar-accent-foreground: "#fafafa"
  sidebar-border: "rgba(255, 255, 255, 0.07)"
  sidebar-ring: "#525252"
  editor-surface: "#1e1e1e"
  git-added: "#81b88b"
  git-modified: "#e2c08d"
  git-deleted: "#c74e39"
  git-renamed: "#73c991"
  git-untracked: "#73c991"
  agent-active: "#16a34a"
typography:
  display:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: 0.01em
  headline-md:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: 0.01em
  body-md:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0.01em
  body-sm:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: 0.01em
  label-lg:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: 0.01em
  label-md:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: 0.01em
  label-sm:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: 0.01em
  label-caps:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 11px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: 0.05em
  mono-sm:
    fontFamily: "'SF Mono', SFMono-Regular, ui-monospace, 'Cascadia Code', Menlo, Consolas, 'Liberation Mono', monospace"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.45
rounded:
  none: 0px
  sm: 6px
  md: 8px
  lg: 10px
  xl: 14px
  "2xl": 18px
  full: 9999px
spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  "2xl": 32px
  titlebar-height: 42px
  sidebar-width-default: 280px
  sidebar-width-min: 220px
  sidebar-width-max: 500px
  traffic-light-pad: 80px
components:
  titlebar:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    height: "{spacing.titlebar-height}"
  sidebar:
    backgroundColor: "{colors.sidebar}"
    textColor: "{colors.sidebar-foreground}"
    width: "{spacing.sidebar-width-default}"
  sidebar-item:
    backgroundColor: transparent
    textColor: "{colors.sidebar-foreground}"
    rounded: "{rounded.sm}"
    padding: 8px 12px
    typography: "{typography.body-sm}"
  sidebar-item-active:
    backgroundColor: "{colors.sidebar-accent}"
    textColor: "{colors.sidebar-accent-foreground}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.label-lg}"
    rounded: "{rounded.md}"
    height: 36px
    padding: 0 16px
  button-primary-hover:
    backgroundColor: "{colors.primary}"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-foreground}"
    typography: "{typography.label-lg}"
    rounded: "{rounded.md}"
    height: 36px
    padding: 0 16px
  button-secondary-hover:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-foreground}"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    borderColor: "{colors.border}"
    typography: "{typography.label-lg}"
    rounded: "{rounded.md}"
    height: 36px
    padding: 0 16px
  button-outline-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
    borderColor: "{colors.border}"
  button-ghost:
    backgroundColor: transparent
    textColor: "{colors.foreground}"
    typography: "{typography.label-lg}"
    rounded: "{rounded.md}"
    height: 36px
    padding: 0 16px
  button-ghost-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "#ffffff"
    typography: "{typography.label-lg}"
    rounded: "{rounded.md}"
    height: 36px
    padding: 0 16px
  button-destructive-hover:
    backgroundColor: "{colors.destructive}"
    textColor: "#ffffff"
  button-sm:
    typography: "{typography.label-lg}"
    rounded: "{rounded.sm}"
    height: 32px
    padding: 0 12px
  button-lg:
    typography: "{typography.label-lg}"
    rounded: "{rounded.sm}"
    height: 40px
    padding: 0 24px
  button-xs:
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
    height: 24px
    padding: 0 8px
  icon-button:
    backgroundColor: transparent
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.sm}"
    size: 36px
  icon-button-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.foreground}"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    borderColor: "{colors.input}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    height: 36px
    padding: 0 12px
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.card-foreground}"
    borderColor: "{colors.border}"
    rounded: "{rounded.lg}"
    padding: 16px
  badge:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: 2px 8px
  agent-badge:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.foreground}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: 3px 8px
---

# Orca Design System

## Overview

Orca is a desktop IDE for developers who run multiple AI coding agents in
parallel. The product surface is dense with signal — worktrees, agents,
terminals, diffs, PR state — and the visual language has to stay out of the
way so that signal reads cleanly.

The personality is **quiet, precise, and native**. Orca should feel like it
belongs next to a terminal and a code editor, not a marketing site. Surfaces
are flat, chrome is thin, color is reserved for state that actually matters
(agent activity, git status, destructive actions). Motion is short and
functional.

Orca supports both light and dark themes from a single semantic token set.
The tokens in this file describe the default (light) theme; the dark theme
remaps the same semantic names — see **Colors → Dark mode**.

## Colors

The palette is built on two layered neutrals plus a single strong
destructive red. Everything else — backgrounds, borders, text — is a shade
of gray chosen to preserve a clear type hierarchy at small sizes in dense
UIs.

- **Primary (#171717):** Near-black ink. Used for the default Button, for
  active sidebar states in dark mode, and as foreground on primary
  surfaces. Not a "brand" color in the marketing sense — it's the highest-
  contrast ink available against the neutral canvas.
- **Foreground / Background:** `#0a0a0a` on `#ffffff` (light) and `#fafafa`
  on `#0a0a0a` (dark). The text-on-background pair is intentionally a few
  points off pure black/white to reduce eye strain during long coding
  sessions.
- **Muted Foreground (#6B6B6B):** The workhorse for captions, metadata,
  timestamps, worktree paths, inactive icon buttons, and any text that
  should recede. Roughly 60% of text in a typical Orca screen uses this.
- **Secondary / Muted / Accent (#f5f5f5):** A single off-white fill shared
  across hover states, badges, pills, and the sidebar's active item. Orca
  intentionally collapses several shadcn roles onto the same value so that
  hover, selection, and filled chips all share one visual layer — this
  keeps the surface quiet.
- **Border (#e5e5e5):** One hairline color for nearly every divider.
  Dividers in Orca are never stronger than the type they separate.
- **Destructive (#e40014):** Reserved for delete actions, error states,
  and destructive confirmations. Never used decoratively.
- **Ring (#8E8E8E):** Focus outline. Always visible via keyboard, never
  suppressed.

> **A11y note:** `muted-foreground` (#6B6B6B) and `ring` (#8E8E8E) are
> one step darker than the values currently committed in
> `src/renderer/src/assets/main.css` (#737373 / #a1a1a1), which sit just
> below WCAG thresholds (4.35:1 for body text on `muted`, 2.58:1 for
> focus-ring non-text contrast on `background`). This file is the
> normative target; the CSS variables should be aligned to these values.



### Git decoration

Orca ships its own source-control view and keeps a dedicated set of status
colors that are distinct from product semantic colors. These are tuned
against the VS Code convention so they feel familiar to users coming from
an editor.

- `git-added` `#587c0c` (light) / `#81b88b` (dark)
- `git-modified` `#895503` (light) / `#e2c08d` (dark)
- `git-deleted` `#ad0707` (light) / `#c74e39` (dark)
- `git-renamed` `#007acc` (light) / `#73c991` (dark)
- `git-untracked` `#007100` (light) / `#73c991` (dark)

### Agent activity

A dedicated green `#16a34a` signals a running agent and is applied as a
small solid dot with an 18%-alpha halo inside the titlebar agent badge and
hover cards. Idle agents use `muted-foreground` — green always means
"something is actively happening right now."

### Reserved role: sidebar-primary

The `sidebar-primary` token is defined (`#171717` light / `#1447e6` dark)
as a reserved role for a future active-workspace indicator. It is not
currently consumed by any component — the active sidebar state today uses
`sidebar-accent`. Treat `sidebar-primary` as a held slot, not a rule to
apply.

### Dark mode

The dark theme remaps the same semantic names. Key differences:

- `background: #0a0a0a`, `foreground: #fafafa`
- `editor-surface: #1e1e1e` — a dedicated dark gray for embedded Monaco
  editor panes so they match the host editor feel instead of the full app
  background.
- `primary: #e5e5e5` with `primary-foreground: #171717` — button inks
  invert cleanly.
- Borders become `rgba(255, 255, 255, 0.07)` — barely-visible 1px lines
  that separate panes without adding weight.
- `destructive: #ff6568` — shifted lighter for AA contrast on dark.

## Typography

Orca uses **Geist** (variable, weights 100–900) as the single product
typeface, with `-apple-system` / `Segoe UI` as cross-platform fallbacks and
`SF Mono` / `ui-monospace` for code, file paths, and terminal UI.

Geist was chosen because it renders well at 11–14px — the range where
~90% of Orca's type lives — and because its metrics hold up next to Monaco
editor content without creating visible baseline jumps.

The system is tuned for **small sizes**. There is no full marketing type
scale; Orca runs in a window, not on a landing page.

- **Display (48px / 700):** Reserved for the Landing empty-state and
  nothing else. Uses `muted-foreground` deliberately — the landing title
  is a wayfinding cue, not a headline.
- **Headline lg/md (18/14, 600):** Section titles inside dialogs and
  editor panes. Never stacked; Orca does not have multi-level headline
  hierarchy inside a view.
- **Body (14/13, 400):** Default reading size. 14px for primary text and
  editor chrome, 13px for list items and sidebar entries.
- **Label (12/11, 500):** Buttons, badges, input affordances, dropdowns.
  Buttons always use label sizing — never body — so they read as
  interactive at a glance.
- **Label caps (11px, 600, tracking 0.05em):** Used for small section
  headers in the sidebar and metadata rows ("WORKTREES", "OPENED FILES").
- **Mono (12px):** Worktree paths, commit SHAs, branch names, terminal UI,
  and the editor-header path row.

All weights set a global `letter-spacing: 0.01em` via `body` to compensate
for Geist's slightly tight default tracking at small sizes. Display-size
text uses negative tracking (`-0.02em`) for optical balance.

## Layout

Orca is a single fixed window laid out as a column stack: a 42px titlebar,
then a flexible content row containing the sidebar and the main work
area. Nothing scrolls the whole window — only individual panes scroll.

- **Titlebar (42px):** Acts as both the macOS drag region and the global
  status strip. Contains the sidebar toggle, the agent-activity badge,
  and window-level icon buttons. On macOS, an 80px traffic-light pad
  reserves space for the native window controls.
- **Sidebar (default 280px, user-resizable between 220px and 500px, and
  collapsible to 0):** Holds a fixed-top nav row, a header, a search bar,
  the virtualized worktree list, and a fixed-bottom toolbar. A 4px-wide
  drag hitbox on the sidebar's right edge drives the resize (absolute-
  positioned, transparent until hovered, then tinted with `ring/20`).
  The hitbox is the interactive surface — there is no separate visible
  1px divider; the sidebar's own `sidebar-border` supplies the hairline.
  The persisted width is clamped into the min/max range on load.
  Collapsed state removes the right border entirely so the content area
  extends edge-to-edge.
- **Content area:** Horizontal flex, 100% width minus sidebar. Worktree
  views may subdivide further into editor / terminal / right-sidebar
  columns using resizable dividers.

### Spacing scale

Orca uses a **4px base grid** with semantic increments. Most surface
padding lands at 8px (tight list rows), 12px (sidebar items, input
insets), or 16px (card padding, dialog bodies). 24px and above are
reserved for modals and landing content. Avoid 2px, 6px, 10px — off-grid
values create visible rhythm breaks when panes sit side by side.

- `xs: 4px` — icon-to-label gaps, pill padding
- `sm: 8px` — compact list rows, badge padding
- `md: 12px` — sidebar item padding, input horizontal padding
- `lg: 16px` — card interior, dialog body
- `xl: 24px` — modal padding, landing gaps
- `2xl: 32px` — landing vertical rhythm

## Elevation & Depth

Orca is a **flat, layered** interface. There is no Material-style elevation
model. Hierarchy is conveyed by:

1. **Tonal surfaces.** `sidebar` (#fafafa) sits on `background` (#ffffff)
   in light; in dark, `editor-surface` (#1e1e1e) sits on `background`
   (#0a0a0a). These tonal steps do the work of shadow.
2. **Hairline borders.** A single `border` value (`#e5e5e5` light /
   `rgba(255,255,255,0.07)` dark) separates panes. Borders are never
   doubled and never combined with shadow on the same edge.
3. **Focused shadows, sparingly.** Popovers, dropdowns, and dialogs use a
   subtle drop shadow (approx. `0 1px 2px rgba(0,0,0,0.05)` light, stronger
   on dark). Diff-comment popovers, which overlay the editor, use a
   heavier `0 10px 24px rgba(0,0,0,0.18)` because they must clearly
   separate from busy code underneath.
4. **Colored rings for focus.** Keyboard focus uses a 3px ring at
   `ring/50` alpha plus a border recolor. Focus is a depth cue, not a
   color accent.

Flash/pulse animations (e.g. settings-section-flash on anchor-scroll) are
300–900ms eased fades applied to the ring color — they announce a
destination without persisting chrome.

## Shapes

Orca uses **soft-rectangular** geometry. The base radius is
`--radius: 0.625rem` (10px); the Tailwind scale derives from it as
`0.6×/0.8×/1×/1.4×/1.8×`.

- **Buttons, inputs, list rows:** `rounded-md` (8px). The default UI
  radius — large enough to read as modern, small enough to sit cleanly
  against square editor content.
- **Cards, dialogs:** `rounded-lg` (10px) to `rounded-xl` (14px).
- **Badges, pills, dots, agent indicators:** `rounded-full` (9999px).
- **Sharp corners (0px):** Scrollbar thumbs, Monaco find-widget internals,
  and the worktree-pane dividers. Anything that sits flush against the
  window edge or inside a tool surface stays square.

Do not mix `sm` and `lg` radii on the same object. A card with a
`rounded-xl` outer edge should not contain a button with `rounded-sm`
corners — the eye reads the mismatch as a layout bug.

## Components

### Buttons

Buttons are built with class-variance-authority; six variants × four sizes.
See `src/renderer/src/components/ui/button.tsx`.

**Variants:**

- **default** — primary ink fill, used for the single most important
  action in a dialog or form. At most one per screen region.
- **secondary** — soft-gray fill. Non-committal affirmative action.
- **outline** — 1px border + background. Dismissive / cancel actions
  when paired with a default primary.
- **ghost** — no chrome until hover. The most common button in Orca,
  used for icon buttons, sidebar actions, and title-bar controls.
- **destructive** — red fill. Used for confirmation buttons in a
  destructive dialog, never in the main UI.
- **link** — unadorned primary-colored text with underline-on-hover.
  For in-flow navigation, not as a CTA.

**Sizes:** `xs` (24px), `sm` (32px), `default` (36px), `lg` (40px), plus
matching icon-only sizes. Default icon buttons share button height with
text buttons so toolbars align.

Default/`sm`/`lg` buttons use `label-lg` typography (14px / 500); only
the `xs` size drops to `label-md` (12px / 500). Buttons never use body
weight (400) so that interactivity reads at a glance even without chrome
(ghost variant).

### Titlebar agent badge

The titlebar agent badge is the single most distinctive Orca component. It
shows a rounded-full pill containing two children only: a green dot (with
an 18%-alpha halo) and the active-agent count. There is no text label in
the trigger — the count alone is the label. The idle state
(zero agents) de-emphasizes to `muted-foreground` and 55% opacity, with
the halo removed from the dot.

The trigger is a button that opens a click-activated Popover, not a
hover card, even though the anchor CSS class is named
`titlebar-agent-hovercard` for historical reasons. The popover content
lists active worktrees and their running agents, and a hide affordance at
the bottom. The badge lives inside the titlebar drag region and
explicitly opts out with `-webkit-app-region: no-drag`; descendant spans
use `pointer-events: none` so the drag region never steals the cursor.

### Inputs

Minimal chrome. 1px input border, 8px radius, 36px height, 14px
horizontal padding, body-sm type. On focus, the border upgrades to
`ring` and the 3px ring appears. No filled backgrounds in light mode;
dark mode uses a subtle `input/30` tint to keep the field visible
against `editor-surface`.

### Cards & Dialogs

Cards use `rounded-lg`, `border`, and `card` background. Dialogs add a
soft drop shadow and close button. Both use 16–24px internal padding.
Dialog titles are `text-lg font-semibold`; descriptions use
`text-sm text-muted-foreground`.

### Sidebar

Default 280px, user-resizable 220–500px, collapsible to 0. The sidebar is
a vertical flex column with five fixed children in order: nav row,
header, search bar, virtualized worktree list (the only scrolling
region), and bottom toolbar. A 4px-wide right-edge hitbox drives the
resize; the hitbox is transparent at rest, fills with `ring/20` on
hover, and `ring/30` while dragging. Do not shrink the hitbox below 4px
— Fitts's Law says a 1px target is effectively invisible to the cursor
and the resize becomes frustrating to find.

Worktree item layout: branch name (13px, foreground) over path (11px,
muted-foreground) with a 2px gap. The active worktree uses the
`sidebar-accent` fill (not `sidebar-primary`, and not a left-border bar).
Collapsing the sidebar animates `width` over 200ms.

### Diff comments

A specific editor component that deserves its own token set because it
overlays Monaco. Saved notes use a `foreground @ 5%` tint over
`editor-surface` with a 3px left accent bar and a subtle drop shadow;
popovers (entering state) share the same treatment with a stronger
shadow so they visibly lift off the diff. Dark-mode uses 6% instead of
5% tint so the absolute luminance delta matches light-mode.

### Scrollbars

Two variants:

- **Sleek** (default): 12px track, thumb as `muted-foreground @ 28%`
  rising to `48%` on parent hover, 0px radius, 3px padding.
- **Editor**: 14px track, rgba(121,121,121,0.4) thumb with 7px radius —
  matches Monaco's native scrollbar so embedded editor panes feel
  continuous with surrounding chrome.

Some surfaces (terminal tab strip) hide scrollbars entirely to prevent
drag-time flicker.

## Do's and Don'ts

- **Do** reserve the green agent dot for genuinely active work. An idle
  agent must never show green — a user glancing at the titlebar should
  learn "something is happening" in under half a second.
- **Do** use `muted-foreground` for metadata (paths, timestamps, counts).
  If you're tempted to use `foreground` for a label, ask whether the user
  needs to read it or just needs to know it's there.
- **Do** stay on the 4px grid. Most spacing bugs in Orca have been off-grid
  padding (10px, 14px) breaking alignment with adjacent panes.
- **Do** let borders do the work of shadows. Add a shadow only when an
  element genuinely floats above others (popovers, dialogs).
- **Do** honor the `Why:` comments in `main.css`. Several visual choices
  there (diff-comment card tint %, titlebar pointer-events, find-widget
  direction) encode past bugs; don't casually revert them.

- **Don't** introduce new chromatic accents. The product chrome is
  neutral-only; color is reserved for state (red = destructive, green =
  running, blue accents = dark-mode active workspace, git decoration
  colors = source control).
- **Don't** mix radii on the same object. A card and its internal buttons
  should share a consistent soft-rectangular family.
- **Don't** use body weight (400) for buttons, badges, or other
  interactive atoms. Interactive type is 500–600.
- **Don't** use drop shadows to separate adjacent panes — that's what
  `border` is for. Reserve shadow for true overlays.
- **Don't** add a third scrollbar style. If a surface feels like it needs
  one, it probably needs `scrollbar-sleek` with different padding.
- **Don't** put destructive red next to the agent green. A screen that
  shows both at the same time is telling the user two urgent things at
  once, which almost always means one of them isn't actually urgent.
- **Don't** place destructive buttons in the titlebar, right-sidebar
  toolbar, or any top-global chrome. Because the agent-activity badge
  (green) lives permanently in the titlebar, a top-chrome destructive
  action would force the two signal colors into constant co-occurrence.
  Destructive actions belong at the bottom-right of dialogs, at the end
  of a form, or inside a context menu — structurally isolated from the
  global activity indicator.
