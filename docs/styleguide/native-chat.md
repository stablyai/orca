# Native chat typography and color

Read before changing anything under `src/renderer/src/components/native-chat/`. Core rules: [`docs/STYLEGUIDE.md`](../STYLEGUIDE.md). `pnpm lint` enforces the type scale, softened-foreground, and focus-ring rules below (`config/ast-grep/rules/native-chat-*.yml`).

## Chat type scale

The native chat uses these steps and no others. Never write an arbitrary size (`text-[13px]`) inside `components/native-chat/`.

| Step             | Default | Use it for                                                                                                 |
| ---------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `text-sm`        | 14px    | Anything the user reads: message prose, tool and agent activity rows, card titles and bodies, the composer |
| `text-xs`        | 12px    | Labels, timestamps, counters, secondary lines under a row                                                  |
| `text-2xs`       | 11px    | Captions, attribution, uppercase category labels                                                           |
| `text-3xs`       | 10px    | Badges and mono pills                                                                                      |
| `text-chat-code` | 12px    | Code blocks, diffs, commands and tool output                                                               |

The chat root (`.native-chat-appearance`) redefines these steps as ratios of the Text size setting, so every tier scales together; `text-chat-code` follows the Code text size setting. The chat root also ties the spacing unit to the text size (4px at the default 14px), so icons, gaps, padding and row heights grow with the text.

- Use spacing-scale utilities (`size-3.5`, `min-h-6.5`, `pl-3.25`), not pixel lengths (`min-h-[26px]`), or the element stays fixed while the rest scales.
- Size an element with one of these utilities only: a CSS rule that sets `font-size` outside a layer silently overrides them.

## Text colour, hover and focus

- **Primary text on the chat canvas** uses `text-chat-foreground`, and `text-chat-foreground-strong` for titles and emphasis; both follow the Contrast setting. Don't soften `text-foreground` by hand (`text-foreground/85`). `text-foreground` is for text on a lifted surface inside the chat.
- **Secondary text on the chat canvas** (transcript rows, notices, labels between messages) uses `text-chat-foreground-faint`. `text-muted-foreground` is for text on a lifted surface inside the chat: cards, menus, popovers and the docks above the composer.
- **Row hover** in the transcript is `hover:bg-accent/20`. Buttons, menu items and card controls use `hover:bg-accent`.
- **Focus rings:** full-width transcript rows use the inset ring (`focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`) so it isn't clipped by the scroll container; standalone controls use `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`. Inside the chat `--ring` is `--chat-focus-ring`, which clears 3:1 on the canvas; don't lower its opacity.
- **State colours:** warnings use `text-chat-warning`; diff lines use `text-chat-diff-added` / `text-chat-diff-removed`; what the reader has not seen yet uses `text-chat-unread`. They are mixed toward the foreground so they pass text contrast in light and dark. Don't use raw palette colours (`text-yellow-500`) or the git decoration tokens for text on a tinted row.
