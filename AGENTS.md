# AGENTS.md

## Code Comments: Document the "Why"

When writing or modifying code driven by a design doc or non-obvious constraint, you **must** add a comment explaining **why** the code behaves the way it does. "What" is visible in the code; "why" is not. Target these categories:

- Safety constraints (suppressed actions, guarded entry points)
- Fallback/error-handling choices and their rationale
- Architectural boundaries (IPC separation, which surface owns a feature)
- Compatibility shims (fields that exist for downstream plumbing, not semantics)
- Intentional omissions (skipped data, unsupported edge cases)

If the design doc has a gotcha, the code must have a comment. A maintainer who hasn't read the doc should still understand why the code must not be changed casually.

## Worktree Safety

Always use the primary working directory (the worktree) for all file reads and edits. Never follow absolute paths from subagent results that point to the main repo.

## Cross-Platform Support

Orca targets macOS, Linux, and Windows. Keep all platform-dependent behavior behind runtime checks:

- **Keyboard shortcuts**: Never hardcode `e.metaKey`. Use a platform check (`navigator.userAgent.includes('Mac')`) to pick `metaKey` on Mac and `ctrlKey` on Linux/Windows. Electron menu accelerators should use `CmdOrCtrl`.
- **Shortcut labels in UI**: Display `⌘` / `⇧` on Mac and `Ctrl+` / `Shift+` on other platforms.
- **File paths**: Use `path.join` or Electron/Node path utilities — never assume `/` or `\`.

## GitHub CLI Usage

Be mindful of the user's `gh` CLI API rate limit — batch requests where possible and avoid unnecessary calls. All code, commands, and scripts must be compatible with macOS, Linux, and Windows.
