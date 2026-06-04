# Code Intelligence IPC Channels

Two channels: `codeIntel:definition` and `codeIntel:references`.

## Request Shape (both channels)

```ts
{
  filePath: string          // absolute path on the host filesystem
  relativePath: string      // worktree-relative POSIX path
  position: { line: number; character: number }  // 0-based
  bufferVersion: number     // editor version ID for stale-response discard
  bufferText?: string       // unsaved editor content overlay
  connectionId?: string     // present = remote/SSH worktree → unsupported
}
```

## Response Shape (both channels)

Returns `CodeIntelResult` (defined in `src/shared/code-intel-contract.ts`):

- `{ status: 'ok', locations: CodeIntelLocation[], truncated: boolean }` — successful query.
- `{ status: 'unsupported', reason: 'remote-runtime' | 'no-tsconfig' | 'not-ts' }` — the file cannot be navigated.
- `{ status: 'error', code: string, message: string }` — unexpected failure.

Each `CodeIntelLocation` carries:

```ts
{
  absolutePath: string  // open this directly; do NOT rebuild from the worktree root
  relativePath: string  // project-root-relative POSIX path, for display only
  range: { start: { line; character }; end: { line; character } }  // 0-based
  preview?: string      // trimmed line text, capped at CODE_INTEL_MAX_PREVIEW_LEN
}
```

## Invariants

- A `connectionId` always yields `unsupported:remote-runtime` (this slice is local-desktop only).
- An empty `ok` (no locations) is distinct from `unsupported` — it means a valid project with zero results.
- `truncated` is `true` when the sidecar capped results at `CODE_INTEL_MAX_LOCATIONS` (1000).
- `absolutePath` is authoritative for opening the target. The sidecar's project root is the nearest `tsconfig.json` directory, which in a monorepo is below the worktree root — so `relativePath` is not safe to join onto the worktree root.
