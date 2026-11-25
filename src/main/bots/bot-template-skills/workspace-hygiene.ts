export const SKILL = `---
name: workspace-hygiene
description: When an Orca workspace is done or abandoned, and what to check before removing it.
---

# Workspace hygiene

## Done or abandoned

- **Done:** its pull request merged or closed, and nothing new since.
- **Abandoned:** no changes for two weeks or more and no open pull request.
- **Folder workspaces** have no branch or pull request: judge them by recent activity only.

## Before removing one, check

1. Uncommitted changes. List the files.
2. Commits that were never pushed.
3. A running agent or terminal in it.

Never remove a workspace with uncommitted or unpushed work unless your owner names it and says so.

## Report

A list: workspace, why it looks done or abandoned, and anything from the checks above. Remove only the ones your owner picks, with \`orca worktree rm\`.
`
