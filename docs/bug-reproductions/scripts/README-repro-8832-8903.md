# Repro tests for #8832, #8595, #8940, #8903

Tests live under `src/` (vitest `include`) so `@/` aliases resolve via `config/vitest.config.ts`.

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/renderer/src/components/terminal-pane/repro-8832-url-next-line.test.ts \
  src/renderer/src/components/terminal-pane/repro-8595-bold-theme-noop.test.ts \
  src/shared/repro-8940-opencode-as-claude.test.ts \
  src/renderer/src/components/cmd-j/repro-8903-cmdj-focus-fallback.test.ts
```

Docs: `docs/bug-reproductions/{8832,8595,8940,8903}.md`
