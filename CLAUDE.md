# CLAUDE.md

See also: [AGENTS.md](./AGENTS.md) for agent-specific rules.

## Fork Strategy

This is a **UX-customization fork** of [stablyai/orca](https://github.com/stablyai/orca). The goal is to personalize the interface while receiving all features, architecture improvements, and bug fixes from upstream.

### Golden Rule

**Never touch upstream architecture. Only customize the UX surface.**

- **UX surface** (our territory): colors, fonts, layout tweaks, sidebar appearance, settings UI, landing page, component styling, keyboard shortcuts
- **Upstream territory** (do not modify): main process (`src/main/`), IPC layer (`src/main/ipc/`), store logic (`src/renderer/src/store/slices/` — except adding new UI-only fields to `ui.ts`), CLI (`src/cli/`), shared types (`src/shared/`), build config, git/GitHub integration

### How to Minimize Merge Conflicts

1. **Prefer new files over editing upstream files.** If adding a custom component, create a new file (e.g., `MyCustomWidget.tsx`) and import it, rather than inlining code into an existing upstream component.
2. **CSS customizations go in one place.** All color/theme overrides belong in `src/renderer/src/assets/main.css` inside the `:root` and `.dark` blocks. This file changes rarely upstream.
3. **If you must edit an upstream file**, keep the diff minimal — add an import + one-line component insertion, not a rewrite.
4. **Mark custom code with comments:** `// FORK: <reason>` so it's easy to find and reapply after a conflict.

### Sync Workflow

Remotes:

- `origin` = `sasha-darkdepot/orca` (our fork)
- `upstream` = `stablyai/orca` (original)

To sync (ask Claude: "sync with upstream"):

```bash
git fetch upstream
git rebase upstream/main
# resolve conflicts if any
git push --force-with-lease origin main
```

Sync at least weekly. The project moves fast.

## Code Comments: Document the "Why"

When implementing behavior driven by a design doc, spec, or non-obvious constraint, **add a comment explaining why** the code does what it does — not just what it does. This is especially important for:

- **Safety constraints** — e.g., suppressing an action because it could silently erase a signal, re-create a conflict, or mislead the user.
- **Fallback/error-handling choices** — e.g., defaulting to `'modified'` on fs error because it's the least misleading option.
- **Architectural boundaries** — e.g., why state lives in the renderer and never crosses IPC, or why a feature belongs to Source Control and not Checks.
- **Compatibility shims** — e.g., when a field exists purely for downstream plumbing and does not carry semantic meaning.
- **Intentional omissions** — e.g., skipping submodule conflicts or not providing rename metadata because the data source doesn't support it.

A future maintainer who hasn't read the design doc should be able to understand from the comment alone why the code must not be changed casually.

## Package Manager

This project uses **pnpm**. Never use `npm` or `yarn`.

- Use `pnpm install` (not `npm install`)
- Use `pnpm add <pkg>` (not `npm install <pkg>`)
- Use `pnpm run <script>` (not `npm run <script>`)
- The lock file is `pnpm-lock.yaml`. Do not generate `package-lock.json` or `yarn.lock`.

## UX Customization Reference

### Theme / Colors

All colors are CSS custom properties in `src/renderer/src/assets/main.css`:

| Variable            | Light     | Dark                      | Purpose             |
| ------------------- | --------- | ------------------------- | ------------------- |
| `--background`      | `#fff`    | `#0a0a0a`                 | App background      |
| `--foreground`      | `#0a0a0a` | `#fafafa`                 | Primary text        |
| `--primary`         | `#171717` | `#e5e5e5`                 | Buttons, emphasis   |
| `--secondary`       | `#f5f5f5` | `#262626`                 | Secondary surfaces  |
| `--muted`           | `#f5f5f5` | `#262626`                 | Disabled/subtle     |
| `--accent`          | `#f5f5f5` | `#404040`                 | Hover states        |
| `--destructive`     | `#e40014` | `#ff6568`                 | Delete/danger       |
| `--border`          | `#e5e5e5` | `rgb(255 255 255 / 0.07)` | Borders             |
| `--sidebar`         | `#fafafa` | `#171717`                 | Sidebar background  |
| `--sidebar-primary` | `#171717` | `#1447e6`                 | Active sidebar item |
| `--editor-surface`  | `#ffffff` | `#1e1e1e`                 | Editor background   |

Theme is toggled via `.dark` class on `<html>`. Controlled by `GlobalSettings.theme` ('system' | 'dark' | 'light').

### Fonts

- **UI font**: Geist Variable (`src/renderer/src/assets/fonts/Geist-Variable.woff2`). To change — replace the woff2 file and update `@font-face` in `main.css`.
- **Terminal font**: User-configurable via Settings. Defaults and fallbacks in `src/renderer/src/components/settings/SettingsConstants.ts`.
- **Editor font**: Monaco editor defaults (configurable).

### Layout

Main layout in `src/renderer/src/App.tsx` (lines 372-431):

```
[Titlebar 38px]
[Sidebar 220-500px] [Center: Terminal / Settings / Landing] [RightSidebar 350px]
```

- Sidebar width stored in `UISlice.sidebarWidth` (default 280px)
- Right sidebar width in `UISlice.rightSidebarWidth` (default 350px)

### Components Safe to Customize

| Component       | Path                                             | What to change                    |
| --------------- | ------------------------------------------------ | --------------------------------- |
| Sidebar         | `src/renderer/src/components/sidebar/`           | Layout, card design, toolbar      |
| Landing page    | `src/renderer/src/components/Landing.tsx`        | Empty state, branding             |
| Settings UI     | `src/renderer/src/components/settings/`          | Panes, controls, organization     |
| Titlebar        | `src/renderer/src/App.tsx` lines 372-400         | Title text, buttons               |
| UI primitives   | `src/renderer/src/components/ui/`                | Button styles, card borders, etc. |
| Update reminder | `src/renderer/src/components/UpdateReminder.tsx` | Notification styling              |

### Components to NOT Customize

| Component            | Path                                                          | Why                                                   |
| -------------------- | ------------------------------------------------------------- | ----------------------------------------------------- |
| Editor internals     | `src/renderer/src/components/editor/`                         | Complex Monaco integration, upstream changes often    |
| Source Control       | `src/renderer/src/components/right-sidebar/SourceControl.tsx` | 1,162 lines of git logic, actively developed upstream |
| File Explorer        | `src/renderer/src/components/right-sidebar/FileExplorer.tsx`  | Core feature, upstream territory                      |
| Terminal engine      | `src/renderer/src/components/terminal-pane/`                  | xterm.js integration                                  |
| All of `src/main/`   | Main process, IPC, filesystem, git                            | Architecture layer                                    |
| All of `src/shared/` | Shared types                                                  | Breaking changes cascade                              |
| All of `src/cli/`    | CLI tool                                                      | Independent feature                                   |

### Icons

Uses `lucide-react`. All icons imported as `import { IconName } from 'lucide-react'`. To swap individual icons — just change the import name. Full icon set: https://lucide.dev/icons

### Build

```bash
pnpm dev              # dev mode with hot reload
pnpm build:mac        # build unsigned .dmg (output: dist/)
pnpm build:mac:release # build signed + notarized (needs Apple creds)
```

No Developer ID needed for personal use. After build: `xattr -cr /Applications/Orca.app` to bypass Gatekeeper.
