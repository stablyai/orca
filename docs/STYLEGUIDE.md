# Orca UI Style Guide

UI rules for Orca. Token values live in `src/renderer/src/assets/main.css` (canonical); this file documents _roles and rules_, not values.

The identity is **monochrome and quiet**: neutral grays carry the chrome, color is reserved for state (selection ring, destructive, git decorations). Orca mostly hosts other tools (Monaco, xterm, Markdown previews), so its own UI should recede and frame. When in doubt:

- Reach for **muted/accent/border** before color.
- Reach for **CSS variables** before hardcoded hex.
- Match the nearest **shadcn primitive** before writing custom CSS.

## Deep dives

Read only when the task touches the topic:

- [`styleguide/color.md`](./styleguide/color.md): full role table, git decorations, list-row states. Read when picking a surface/foreground pair or styling rows.
- [`styleguide/components.md`](./styleguide/components.md): button, primitive-picker, tooltip, icon, shortcut-chip, form, and scrollbar specs. Read when touching one.
- [`styleguide/native-chat.md`](./styleguide/native-chat.md): chat type scale and colours. Read before any change under `components/native-chat/`.
- [`styleguide/ux-rules.md`](./styleguide/ux-rules.md): rationale for the UX rules below. Read when a rule's application is unclear.
- [`styleguide/ux-review-rubric.md`](./styleguide/ux-review-rubric.md): screen review rubric. Read when reviewing or polishing a screen, screenshot, or prototype.

## Tokens

- Colors, `@theme inline` bindings, typography, scrollbars, and titlebar chrome live in `main.css`; primitives in `src/renderer/src/components/ui/`.
- Never hardcode a hex value in component code if a variable already covers it. A new token goes in `main.css` in both `:root` and `.dark`, is exposed in `@theme inline`, then used.
- Need a tint? `color-mix(in srgb, var(--token) N%, var(--background))` against an existing token, never a new hex, so light/dark parity stays automatic.

## Color

Tokens pair a **surface** with a **foreground** that meets contrast on it; always use them together. Role summary (full table in [color.md](./styleguide/color.md)):

- `background` = app canvas; `card` = panels lifted off it; `popover` = floating menus; `input` = form field background only.
- `primary` = the single affirmative action in a flow, never decoration, hover, or secondary actions. `secondary` = lower-emphasis sibling.
- `muted` = de-emphasized text, captions, placeholders, disabled chrome; not body copy.
- `accent` = hover/active backgrounds for ghost buttons and list rows; not solid filled buttons (use `secondary`).
- `destructive` = delete/discard/irreversible actions and error states; never Cancel.
- `border` = all hairlines; `ring` = focus-visible outlines and selection halos, not persistent decoration.
- `sidebar*` only inside the worktree sidebar; `editor-surface` for Monaco/markdown editor panes, not app chrome.
- `--git-decoration-*` only for git status, never other state.
- **List rows:** idle transparent; hover `bg-accent` (`bg-sidebar-accent` in the sidebar); cmdk keyboard selection must not rely on flat `bg-accent` on light popovers/dialogs — use the `.jump-palette-item[data-selected='true']` recipe in `main.css`; the persistent current row is `bg-accent` plus `data-current="true"`. Never invent a "selected" color.

## Typography

- Sans is `Geist`, never `Inter` or system sans. Mono is `var(--font-mono)` for paths, code, terminal-adjacent UI, and anything literal.
- Body letter-spacing is set globally on `body`; don't override per component.
- Use Tailwind's scale. Common: 14px body/default buttons, 13px sidebar items and dense rows, 12px sub-text and paths, 11px uppercase meta/captions.
- Use `text-2xs` (11px) and `text-3xs` (10px), not `text-[11px]` / `text-[10px]`.
- Category labels: 11px, `font-semibold`, `uppercase`, `tracking-wider` (0.05em).
- Native chat has its own lint-enforced scale and colours: see [native-chat.md](./styleguide/native-chat.md).

## Radius and elevation

- Radii derive from `--radius` in `main.css`. Buttons and inputs use `rounded-md`, `Card` uses `rounded-xl`, badges use `rounded-full`. Match the existing primitive's radius; don't introduce a new one.
- Three elevation levels, no fourth: (1) `border` hairline, the default for almost everything; (2) `shadow-xs` + single-token border for outline buttons and embedded cards; (3) `shadow-floating`, reserved for popovers and popups that escape the editor surface. Needing more than floating usually means you want the focus `ring`.

## Components

- Use the primitives in `src/renderer/src/components/ui/` before anything custom. Never reimplement headless behavior; extend the existing wrapper. Keep `data-slot` on roots, merge with `cn()` passing caller `className` last, and use CVA for multiple variants ([conventions](./styleguide/components.md#primitive-conventions)).
- **Buttons:** `default` = the single affirmative action; `secondary` next to it; `outline` for toolbar/standalone; `ghost` for icon buttons and row triggers; `link` inline in prose; `destructive` never for Cancel. Match the size to the row height.
- **Picking a primitive:** `Tooltip` (icon labels), `HoverCard` (rich preview), `DropdownMenu` (click menu), `ContextMenu` (right-click), `Popover` (click-revealed form/picker), `Dialog` (blocking decision only), `Sheet` (edge panel), `Select` (known list), `Command` in `Popover` (search), `repo-multi-combobox` pattern (searchable multi-select), `sonner` (transient confirmation), inline text + `Badge` (persistent status). Don't style one primitive to act like another ([table](./styleguide/components.md#picking-the-right-primitive)).
- Every dialog asking the user to trust, approve, run, or remove code (including plugin provenance/approval) uses `DialogContent surface="security"` so plugin themes can't restyle it; add `scrollable` when the whole dialog scrolls. Trust decisions outside a dialog (agent approval card, certificate override) go in `SecuritySurface`.
- Above a modal, only toast close buttons remain clickable. Dismissing a toast must leave the modal open, with focus and unsaved input intact.
- **Tooltips** only name controls: never for visibly labeled controls, interactive content, or critical messages (those go inline). Use the app-root `TooltipProvider`, `<TooltipTrigger asChild>`, and `side="top" sideOffset={4}` by default ([spec](./styleguide/components.md#tooltips)).
- **Icons:** `lucide-react` only, default `size-4`, default stroke, color inherited from text. Loading is `<Loader2 className="size-4 animate-spin" />` ([spec](./styleguide/components.md#icons)).
- **Shortcut chips:** always `<ShortcutKeyCombo />` (or `<DropdownMenuShortcut>` in menus), never a one-off `<kbd>` or keys baked into label strings. The label MUST match the platform's actual binding. Never on Cancel, Dismiss, or `link` actions ([spec](./styleguide/components.md#keyboard-shortcut-chips)).
- **Forms:** follow `settings/SettingsFormControls.tsx`; errors via `aria-invalid`, never a hand-painted ring ([spec](./styleguide/components.md#form-anatomy)).
- **Scrollbars:** use `.scrollbar-sleek`, `.scrollbar-editor`, or `.worktree-sidebar-scrollbar` (sidebar only); don't write a fourth ([spec](./styleguide/components.md#scrollbars)).

## UX rules

These apply to every UI change. Rationale: [ux-rules.md](./styleguide/ux-rules.md). Reviewing a screen: [ux-review-rubric.md](./styleguide/ux-review-rubric.md).

- **UI copy must not overclaim.** Never imply the app took an action, made a decision, or observed a fact without real state or result data. Use neutral process language while pending; reserve result verbs ("skipped", "protected", "found", "verified", "deleted") for actual results. Copy is typo-free, concise, specific, and free of filler ("please", "simply", "just").
- **Match in-flight feedback to duration:** 0–100 ms none; 100 ms–1 s disabled only; 1–3 s disabled + spinner or label swap; 3 s+ or multi-step stage labels/progress. Pre-reserve space for label/icon swaps (`width`, not `min-width`). Bind disabled immediately; defer visible loading ~200 ms so local stays clean and SSH gets feedback.
- **Match siblings:** adjacent components in the same flow share icons, shortcut conventions, and submit semantics. Diverge only for a real role difference, or fix both. With no sibling, match the surrounding chrome.
- **Keep the back-out path quiet:** Cancel, Dismiss, Close, and Discard are not destructive: ghost, no color, no shortcut chip, no animated affordance. Esc still works.
- Primary action obvious; common workflows in 1–2 actions; default focus on the likely field or primary action; Enter submits it, Esc backs out.
- Respect reduced motion per element: `motion-reduce:` for movement, still-but-working states for spinners (`LoadingSpinner`), and `motionSafeScrollBehavior()` for scripted scrolls.
- Missing data shows a direct action to acquire it. Toasts for transient results; inline persistent errors when the user must read, retry, copy, or act.

## Cross-platform

Every UI change must hold up on macOS, Linux, and Windows, in light and dark mode.

- Never hardcode `e.metaKey`: choose `metaKey` on Mac and `ctrlKey` elsewhere via `navigator.userAgent.includes('Mac')`. Menu accelerators use `CmdOrCtrl`.
- Labels show `⌘` / `⇧` on Mac and `Ctrl+` / `Shift+` elsewhere, matching the actual binding.
- On Mac, keep hit targets out of the traffic-light gutter (`titlebar-traffic-light-pad`).
- Loading, focus, and animation must hold up under 50–200 ms of SSH latency; verify under simulated latency or real SSH, not local only.

## When this guide is silent

If you have a UI question this doc doesn't answer:

1. Look at adjacent code in `src/renderer/src/components/` for the closest sibling, and follow its lead.
2. Check `src/renderer/src/components/ui/` for a primitive that already encodes the pattern.
3. If it's a token question, `main.css` is canonical — use what's there, or add a new one in both light and dark.
4. If none of those resolve it, ask the user before inventing.
