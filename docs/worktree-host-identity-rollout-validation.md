# Worktree Host Identity Rollout Validation

## Goal

Use host-qualified worktree IDs so the same repo/path on different execution hosts cannot collide:

```text
orca-worktree://v1?hostId=<url-encoded-host>&repoId=<url-encoded-repo>&path=<url-encoded-absolute-path>
```

Legacy IDs (`repoId::path`) remain accepted at public and persisted boundaries. Runtime and newly written state should resolve to canonical host-qualified IDs.

All canonical query values are URL-encoded. For example, `/absolute/path` is stored as `path=%2Fabsolute%2Fpath`.

## Compatibility Rules

- New worktree IDs are canonical and include `hostId`, `repoId`, and `path`.
- Legacy `repoId::path` IDs are parsed and accepted for existing sessions, metadata, cleanup requests, terminal selectors, browser scopes, and runtime CLI/mobile calls.
- When Orca can prove a legacy ID maps to exactly one canonical repo/path/host, it returns and stores the canonical ID.
- Existing legacy metadata and lineage are read through alias lookups before stamping new canonical metadata.
- Old daemon PTY ids may remain legacy as PTY ids, but their owning `worktreeId` is canonicalized when the repo/path match is known.
- Teardown sweeps both canonical and legacy PTY/session prefixes so old sessions are still killed during removal.

## Risks Addressed

- Local and SSH worktrees with the same repo/path no longer share one ID.
- Legacy metadata remains visible during SSH reconnect/disconnected fallback.
- Legacy terminal/session ids do not create duplicate runtime buckets after migration.
- Cleanup preflight and skip-git deferrals accept both old and new ids.
- Runtime lineage records seeded under legacy ids still attach to canonical worktree rows.

## Automated Evidence

Passing after fixes:

- `pnpm exec vitest run src/shared/worktree-id.test.ts src/main/daemon/pty-session-id.test.ts src/main/ipc/worktrees.test.ts`
- `pnpm exec vitest run src/main/persistence.test.ts -t "migrateWorktreeIdentity|host-partitioned workspace sessions"`
- `pnpm exec vitest run src/main/ipc/workspace-cleanup.test.ts src/main/ipc/remote-workspace.test.ts src/shared/remote-workspace-session-projection.test.ts src/main/memory/hydrate-local-pty-registry.test.ts`
- `pnpm exec vitest run src/main/runtime/orca-runtime.test.ts -t "worktree|ManagedWorktree|listManagedWorktrees|createManagedWorktree"`
- `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/store/slices/worktrees.test.ts -t "migrateWorktreeIdentity"`
- `pnpm run typecheck:node`
- `pnpm run typecheck:web`
- targeted `oxlint`
- `git diff --check`

Node engine warning observed locally: repo wants Node 24; validation environment is Node v26.

## Electron Evidence

- Launched Electron with an isolated user data directory.
- Verified the app identity matched this worktree before interacting.
- Added a temp git repo and created an Orca-managed worktree through the app.
- Confirmed the visible sidebar rendered the created workspace.
- Confirmed store state used a canonical `orca-worktree://v1?...hostId=local...` id.
- Removed the created workspace through a legacy `repoId::path` id and verified the canonical row disappeared.
- Shut down only the Electron process launched for validation.
