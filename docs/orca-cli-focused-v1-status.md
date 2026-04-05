# Orca CLI Focused V1 Status

## Purpose

This document records the focused Orca CLI v1 that is now implemented.

The broader design docs still describe a larger eventual CLI surface. This file exists so maintainers can see:

- what is actually shipped now
- what has been intentionally deferred
- the one remaining gap if we want to call the worktree/terminal surface fully complete

## Focused V1 Goal

The focused v1 CLI is intentionally narrow.

It optimizes for Orca's core differentiator:

- managing parallel worktrees from a running Orca editor
- discovering live terminals in those worktrees
- reading and replying to those terminals from an agent

This keeps the public surface centered on Orca's orchestration value instead of reimplementing every editor-adjacent capability in the first CLI release.

## Implemented Now

The following commands are implemented against the running Orca app:

- `orca status`
- `orca repo list`
- `orca repo add`
- `orca repo show`
- `orca repo set-base-ref`
- `orca repo search-refs`
- `orca worktree list`
- `orca worktree show`
- `orca worktree create`
- `orca worktree set`
- `orca worktree rm`
- `orca worktree ps`
- `orca terminal list`
- `orca terminal show`
- `orca terminal read`
- `orca terminal send`
- `orca terminal wait --for exit`
- `orca terminal stop`

## What These Commands Cover

Focused v1 supports the complete agent loop for worktree orchestration:

1. Inspect current Orca runtime availability.
2. Discover the enclosing Orca-managed worktree from the current shell directory.
3. Discover repos indirectly through existing worktrees and summary views.
4. Create a new worktree in a chosen repo.
5. Attach or update worktree metadata like display name, linked issue, and comment.
6. Inspect many worktrees at once with `worktree ps`.
7. Discover live terminal handles in a worktree.
8. Read terminal output with bounded token-efficient reads.
9. Send input back to the terminal.
10. Stop live terminals for a worktree when needed.

It also covers the adjacent setup tasks needed to make worktree creation usable:

- discover and inspect repos already known to Orca
- add a repo path to Orca
- set or inspect a repo base ref

## Intentionally Omitted Wait Modes

Focused v1 includes `terminal wait --for exit`.

The richer wait modes remain intentionally out of scope:

- `--for input`
- `--for idle`
- `--for output`

Those modes require stronger runtime instrumentation and should not be shipped as guesses.

## Intentionally Deferred Beyond Focused V1

These command groups are still deferred:

- `git`
- `gh`

They may still be useful later, but they are not required for the core Orca CLI story.

`git` and `gh` are still deferred because they would further expand the public runtime surface and deserve a separate pass on selector shape, output contracts, and failure handling.

The design reason is simple:

- agents often already have other tools for file, git, GitHub, and search access
- Orca is differentiated by worktree and live terminal orchestration
- broadening the CLI too early would increase surface area faster than it increases unique agent capability

## Relationship To Other Docs

- [orca-cli-v1-spec.md](./orca-cli-v1-spec.md) defines the stricter command contract and runtime assumptions.
- [orca-runtime-layer-design.md](./orca-runtime-layer-design.md) explains the runtime architecture that makes the live terminal surface safe.
- [orca-cli-bundled-distribution.md](./orca-cli-bundled-distribution.md) explains how the bundled desktop-app installation and PATH registration model works.

This status file is the source of truth for the currently implemented focused v1 scope.
