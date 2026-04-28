# AGENTS.md

## Code Comments: Document the "Why", Briefly

When writing or modifying code driven by a design doc or non-obvious constraint, add a comment explaining **why** the code behaves the way it does.

Keep comments short — one or two lines. Capture only the non-obvious reason (safety constraint, compatibility shim, design-doc rule). Don't restate what the code does, narrate the mechanism, cite design-doc sections verbatim, or explain adjacent API choices unless they're the point.

## File and Module Naming

Never use vague names like `helpers`, `utils`, `common`, `misc`, or `shared-stuff` for files, folders, or modules. They carry zero information and tend to become dumping grounds. Name files after what they *actually* contain — prefer the concrete domain concept (e.g. `tab-group-state.ts`, `terminal-orphan-cleanup.ts`) over the generic role (`tabs-helpers.ts`, `terminal-utils.ts`). If you find yourself reaching for `helpers`, the file probably has more than one responsibility and should be split, or there's a better name hiding in the code that describes what the functions operate on.

## Worktree Safety

Always use the primary working directory (the worktree) for all file reads and edits. Never follow absolute paths from subagent results that point to the main repo.

## Cross-Platform Support

Orca targets macOS, Linux, and Windows. Keep all platform-dependent behavior behind runtime checks:

- **Keyboard shortcuts**: Never hardcode `e.metaKey`. Use a platform check (`navigator.userAgent.includes('Mac')`) to pick `metaKey` on Mac and `ctrlKey` on Linux/Windows. Electron menu accelerators should use `CmdOrCtrl`.
- **Shortcut labels in UI**: Display `⌘` / `⇧` on Mac and `Ctrl+` / `Shift+` on other platforms.
- **File paths**: Use `path.join` or Electron/Node path utilities — never assume `/` or `\`.

## GitHub CLI Usage

Be mindful of the user's `gh` CLI API rate limit — batch requests where possible and avoid unnecessary calls. All code, commands, and scripts must be compatible with macOS, Linux, and Windows.

## Type Declarations: Prefer `.ts` Over `.d.ts`

Project-owned type declarations belong in `.ts` files. `.d.ts` is reserved for ambient shims (e.g., `env.d.ts`, `vite/client.d.ts`). TypeScript's `skipLibCheck: true` setting applies globally, including to our own `.d.ts` files, which means any unresolved type reference in a `.d.ts` silently becomes `any` at its call sites. Write your types in `.ts` files so the compiler actually checks them. CI enforces this for `src/preload/` and `src/shared/` — see `docs/preload-typecheck-hole.md`.
