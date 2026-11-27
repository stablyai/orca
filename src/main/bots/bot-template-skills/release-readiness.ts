export const SKILL = `---
name: release-readiness
description: What blocks a release and how to list it, from failing checks to open blockers.
---

# Release readiness

A release is ready when nothing on this list is open. Keep the list short and current.

## What blocks a release

1. **Failing required checks** on the release branch or on pull requests marked for the release.
2. **Pull requests waiting for review** that the release needs.
3. **Open blocker issues:** labelled blocker, or assigned to the release milestone and not closed.
4. **Unmerged fixes** for a regression found since the last release.

## How to list it

- Group by the four kinds above, with links.
- For each item: who owns it and how long it has been waiting.
- First line: blocked or ready, and the single biggest blocker.
- Leave out anything that doesn't block. Nice-to-haves go in a separate "after the release" line, if at all.

## Keep it honest

- Re-check each item before reporting it; a merged pull request or a green re-run is no longer a blocker.
- Don't mark the release ready on your own. Say it looks ready and let your owner decide.
`
