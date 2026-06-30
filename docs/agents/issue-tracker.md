# Issue tracker: GitHub

Issues, PRDs, and task slices for this work live in the `Nikolatesla-lj/orca` fork's GitHub Issues. Use the `gh` CLI for issue operations.

## Repository

This worktree has these GitHub remotes:

- `origin`: `https://github.com/stablyai/orca.git`
- `fork`: `https://github.com/Nikolatesla-lj/orca.git`

Use the fork issue tracker for the Orca Sandcastle-like Pipeline work:

- Issue tracker: `Nikolatesla-lj/orca`
- Upstream code source: `stablyai/orca`

## Conventions

- **Create an issue**: `gh issue create --repo Nikolatesla-lj/orca --title "..." --body "..."`
- **Read an issue**: `gh issue view <number> --repo Nikolatesla-lj/orca --comments`
- **List issues**: `gh issue list --repo Nikolatesla-lj/orca --state open --json number,title,body,labels,comments`
- **Comment on an issue**: `gh issue comment <number> --repo Nikolatesla-lj/orca --body "..."`
- **Apply or remove labels**: `gh issue edit <number> --repo Nikolatesla-lj/orca --add-label "..."` / `--remove-label "..."`
- **Close an issue**: `gh issue close <number> --repo Nikolatesla-lj/orca --comment "..."`

Batch `gh` requests when possible to avoid unnecessary GitHub API usage.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `Nikolatesla-lj/orca` unless the user gives a different repository.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --repo Nikolatesla-lj/orca --comments`.
