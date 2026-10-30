# Component specs

Per-primitive detail behind [`docs/STYLEGUIDE.md`](../STYLEGUIDE.md#components). Read the section for the primitive you are adding or changing.

## Primitive conventions

The shadcn-style wrappers in `src/renderer/src/components/ui/` follow a consistent pattern:

- Most carry a `data-slot="<name>"` attribute on their root for CSS targeting — do not strip it. The non-shadcn helpers in this folder (`sonner`, `repo-multi-combobox`) don't follow this pattern and shouldn't be modeled when adding new primitives that should.
- Use `cn()` for class merging. Pass user `className` last so callers can override.
- Use `class-variance-authority` (CVA) for variants when there are multiple.
- Most wrap a Radix UI primitive. Exceptions are `command` (wraps `cmdk`), `sonner` (wraps `sonner`), and the visual-only wrappers (`badge`, `button-group`, `card`, `input`), which apply tokens and Tailwind utilities directly. Never reimplement headless behavior; extend the existing wrapper.

## Buttons (`button.tsx`)

Variants in priority order:

| Variant       | Use case                                                           |
| ------------- | ------------------------------------------------------------------ |
| `default`     | The single affirmative action in a flow.                           |
| `secondary`   | Lower-emphasis sibling next to a `default`.                        |
| `outline`     | Toolbar / standalone actions where a filled button feels heavy.    |
| `ghost`       | Icon buttons, list-row triggers, anywhere chrome should disappear. |
| `link`        | Inline text actions inside paragraphs.                             |
| `destructive` | Delete, discard, irreversible. Never for Cancel.                   |

Sizes are defined in `button.tsx` (`default`, `sm`, `xs`, `lg`, plus `icon`, `icon-xs`, `icon-sm`, `icon-lg`). Match the size to the surrounding row height — don't drop a `default` button into a 28px toolbar.

## Picking the right primitive

| You want…                                                    | Reach for                                  | Don't use                             |
| ------------------------------------------------------------ | ------------------------------------------ | ------------------------------------- |
| Hover-only label on an icon-only button                      | `Tooltip`                                  | `HoverCard` (too heavy), title attr   |
| Hover preview of richer content (avatar + summary)           | `HoverCard`                                | `Tooltip` (no rich content)           |
| Click-revealed menu with actions                             | `DropdownMenu`                             | `Popover` with hand-rolled list       |
| Right-click contextual actions                               | `ContextMenu`                              | `DropdownMenu` (different invocation) |
| Click-revealed surface with arbitrary content (form, picker) | `Popover`                                  | `Dialog` (it traps focus and dims)    |
| Modal that demands a decision before you continue            | `Dialog`                                   | `Popover`, inline overlay             |
| Drawer / panel sliding in from an edge                       | `Sheet`                                    | `Dialog` centered                     |
| Single choice from a known list                              | `Select`                                   | Custom listbox                        |
| Single choice with search / fuzzy filtering                  | `Command` inside `Popover`                 | `Select` (no search)                  |
| Multi-select with search                                     | `repo-multi-combobox` (mirror its pattern) | Roll a new one                        |
| Transient confirmation ("Saved", "Copied")                   | `sonner` toast                             | `Dialog`, inline banner               |
| Persistent inline status ("3 errors")                        | inline text + `Badge`                      | toast (toasts disappear)              |

If you find yourself styling around a primitive (`<Popover>` to act like a `<Dialog>`, or vice versa), stop and reconsider — the focus-management semantics differ and a future contributor will be misled by the mismatch.

## Tooltips

Tooltips exist to _name_ a control whose meaning isn't obvious from its appearance. They are not the place to teach, persuade, or warn — anything users need to read while acting belongs in the visible UI.

- **Use a tooltip when:** an icon-only button or compact chip needs a label. Toolbar icons, badges with abbreviations, truncated paths.
- **Don't use a tooltip when:** the control already has a visible label, the content is interactive (links, buttons), or the message is critical (errors, blocking warnings — those go inline).
- **Mounting:** the global `<TooltipProvider delayDuration={400}>` lives at the App root. Don't nest a second `TooltipProvider` unless you need a different delay for a tightly-scoped surface.
- **Trigger pattern:** wrap the trigger element with `<TooltipTrigger asChild>` so the tooltip's accessibility props attach to the button (not a wrapper span). This is required for keyboard focus to surface the tooltip.
- **Placement:** default `side="top" sideOffset={4}` — match the toolbar pattern in `sidebar/SidebarToolbar.tsx`. Pick a different side only when the default would clip against the viewport.
- **Shortcut chips inside tooltips:** if the action has a keyboard shortcut, append `<ShortcutKeyCombo />` rather than baking the keys into the label string. The chips render correctly per platform; baked-in strings drift.

```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <Button variant="ghost" size="icon-sm" onClick={openSettings}>
      <Settings />
    </Button>
  </TooltipTrigger>
  <TooltipContent side="top" sideOffset={4}>
    Settings
  </TooltipContent>
</Tooltip>
```

## Icons

Icons come from **`lucide-react`**. Don't import a second icon library.

- **Default size:** `size-4`. `Button` auto-applies this to any `<svg>` it contains via `[&_svg:not([class*='size-'])]:size-4`, so most call sites don't need to set a size on the icon.
- **`size-3` / `size-3.5`:** for metadata, captions, and dense list rows where `size-4` is too loud.
- **`size-7`+:** for featured/empty-state hero icons only.
- **Stroke width:** lucide's default. Don't override per-icon.
- **Color:** inherit from surrounding text — `text-muted-foreground` for secondary, `text-destructive` for destructive, etc. Don't apply a token to the SVG directly when the parent already carries the right color.
- **Spinner:** the canonical loading icon is `<Loader2 className="size-4 animate-spin" />`. For 3s+ multi-step work, prefer a label that names the stage ("Cloning…" → "Installing…") over an unlabeled spinner. See [in-flight feedback](./ux-rules.md#1-match-in-flight-feedback-to-perceived-duration).

## Keyboard shortcut chips

Use **`<ShortcutKeyCombo />`** from `src/renderer/src/components/ShortcutKeyCombo.tsx`. It renders a consistent key-cap style and inserts a `+` separator on Windows/Linux (Mac shows adjacent glyphs, no separator). It does **not** transform key strings — the _caller_ picks the platform-appropriate labels and passes them in:

```tsx
const isMac = navigator.userAgent.includes('Mac')
const mod = isMac ? '⌘' : 'Ctrl'
const shift = isMac ? '⇧' : 'Shift'
<ShortcutKeyCombo keys={[mod, shift, 'N']} />
```

See `Landing.tsx` for the canonical pattern. Don't roll a one-off `<kbd>` — kbd chips drift in shape and color across the app fast if everyone styles their own.

Where shortcuts surface in the UI:

- **Tooltips on icon buttons** — append the chip after the label, trailing.
- **Dropdown / context-menu items** — use `<DropdownMenuShortcut>` (or its context-menu equivalent) for the right-aligned chip; don't position one yourself.
- **Never on Cancel, Dismiss, or `link`-variant inline actions** — see [the back-out path](./ux-rules.md#3-dont-overload-the-back-out-path).

**The label MUST match the actual binding for the platform.** If the keyboard handler reads `metaKey` on Mac and `ctrlKey` elsewhere, the chip must show `⌘` on Mac and `Ctrl` elsewhere. Mismatched chips are worse than no chip.

## Form anatomy

The pattern in `src/renderer/src/components/settings/SettingsFormControls.tsx` is the house style for any label + control + helper text. Match it for new forms:

- **Outer stack:** `space-y-3` for full-section forms (`ThemePicker`); `space-y-2` for compact single-control fields (`ColorField`, `NumberField`). Pick by density, not preference.
- **Label group:** `space-y-1` containing `<Label>` and a description in `text-xs text-muted-foreground`.
- **Control:** the shadcn primitive (`<Input>`, `<Select>`, etc.). Errors surface via `aria-invalid`; the input primitive already maps that to a destructive ring — don't paint your own.
- **Trailing metadata:** `text-2xs text-muted-foreground` below the control (e.g., "Current: 14px · Default: 13px"), not next to the label.

## Scrollbars

Three scrollbar classes are defined globally in `main.css`. Apply one of these to overflow containers; don't write a fourth style.

- **`.scrollbar-sleek`** — the default thin, neutral scrollbar for sidebars, lists, popovers. Pair with `.scrollbar-sleek-parent` on a hover-target ancestor if you want the thumb to fade in only on parent hover.
- **`.scrollbar-editor`** — slightly heavier, used inside Monaco-adjacent surfaces.
- **`.worktree-sidebar-scrollbar`** — no reserved gutter: paired with `overflow-y-auto`, the scrollbar (and its width) exists only while content actually overflows, so a short list stays flush with the fixed header controls and classic-scrollbar Windows shows no arrow buttons on empty lists. The thumb stays invisible until the parent (`.scrollbar-sleek-parent`) is hovered. Used only in the worktree sidebar.
