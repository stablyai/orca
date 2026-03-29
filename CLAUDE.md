# CLAUDE.md

See also: [AGENTS.md](./AGENTS.md) for agent-specific rules.

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
