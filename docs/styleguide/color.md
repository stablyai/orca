# Color roles in detail

Deep reference for [`docs/STYLEGUIDE.md`](../STYLEGUIDE.md#color). Values live in `src/renderer/src/assets/main.css` (`:root`, `.dark`); this file documents roles only.

## Role table

Tokens come in pairs: a **surface** and a **foreground** that meets contrast on it. Always use them together.

| Role                                     | Use it for                                                  | Don't use it for                                    |
| ---------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| `background` / `foreground`              | App canvas, default text                                    | Cards, popovers, sidebar (have their own)           |
| `card` / `card-foreground`               | Panels lifted off the canvas                                | The canvas itself                                   |
| `popover` / `popover-foreground`         | Floating menus, dropdowns, hovercards                       | Inline UI                                           |
| `primary` / `primary-foreground`         | The single affirmative action in a flow (Save, Confirm)     | Decorative accents; hover states; secondary actions |
| `secondary` / `secondary-foreground`     | Lower-emphasis actions next to a primary                    | The affirmative action                              |
| `muted` / `muted-foreground`             | De-emphasized text, captions, placeholders, disabled chrome | Body copy; primary actions                          |
| `accent` / `accent-foreground`           | Hover/active backgrounds for ghost buttons and list rows    | Solid filled buttons (use `secondary` instead)      |
| `destructive` / `destructive-foreground` | Delete, discard, irreversible-action buttons; error states  | Cancel buttons (Cancel is not destructive)          |
| `border`                                 | All hairlines: dividers, input outlines, card edges         | Heavy emphasis; that's `ring`                       |
| `input`                                  | Form field background only                                  | Anywhere outside form fields                        |
| `ring`                                   | Focus-visible outlines, active selection halos              | Persistent decoration                               |
| `sidebar` (+ variants)                   | The worktree sidebar and its children                       | Other panels                                        |
| `editor-surface`                         | Background of Monaco / markdown editor panes                | App chrome                                          |

The `sidebar` family (`--sidebar`, `--sidebar-foreground`, `--sidebar-primary`, `--sidebar-primary-foreground`, `--sidebar-accent`, `--sidebar-accent-foreground`, `--sidebar-border`, `--sidebar-ring`) is for use inside the worktree sidebar so its hover/selected/focus states stay consistent and don't bleed into other panels.

`editor-surface` is its own token (not just `background`) because Monaco and the markdown editor have a slightly darker surface in dark mode to match common editor conventions; reach for it whenever you're rendering an editor pane.

## Git decoration colors

For diff status, file-tree decorations, and the changes view, use the `--git-decoration-*` tokens: `added`, `modified`, `deleted`, `renamed`, `untracked`, `copied`, `ignored`. The palette mirrors the conventions users already know from other editors, so they aren't surprised.

Use these _only_ for git status. Don't reuse them for unrelated state colors — that breaks the convention.

## List rows: hover, selected, current

A common point of drift. Use these conventions for any list-style row (worktrees, command palette items, settings nav):

- **Idle:** transparent background.
- **Hover:** `bg-accent` (in the worktree sidebar, `bg-sidebar-accent`).
- **Keyboard-selected (cmdk highlight):** do **not** rely on flat `bg-accent` alone on light popover/dialog surfaces — light `--accent` is nearly identical to `--background`, so the cursor vanishes. Use the jump-palette recipe in `main.css` (`.jump-palette-item[data-selected='true']`): `color-mix` foreground into background plus an inset ring. Expose the mix as `--jump-palette-selection-surface` when nested cutouts (status pips) must match. The `data-selected` attribute is set by `cmdk` automatically.
- **Persistent "current" / "active" row** (e.g. the worktree the user is viewing): also `bg-accent`, _plus_ a `data-current="true"` attribute so CSS or future styling can distinguish it from the cmdk highlight.
- **Don't:** hardcode `bg-[#ededed]` / `bg-[#333333]` or invent a "selected" color. Mix from existing tokens (`foreground`/`background`/`accent`) so light/dark stay aligned.

## Color mixing

When you need a tint (e.g. a 12% primary wash on hover), use `color-mix` against the existing token, not a new hex. This keeps light/dark parity automatic:

```css
background: color-mix(in srgb, var(--primary) 12%, var(--background));
```
