export const SKILL = `---
name: release-notes-style
description: Write release notes for users in three groups, new, fixed and changed, without internal detail.
---

# Release notes

Notes are for the people who use the product, not for the people who built it.

## Gather

- Find the last release tag and list every pull request merged since then.
- Skip refactors, test-only changes, dependency bumps with no user effect, and internal tooling.

## Write

Three groups, in this order, each a short bulleted list:

- **New:** things users can do now that they couldn't before.
- **Fixed:** problems users could hit that are gone. Say what used to go wrong, not how it was fixed.
- **Changed:** things that work differently now, including anything removed.

Each bullet is one sentence in plain words. Lead with what the user sees. Leave out code names, file names and internal project names. Link the pull request at the end only if your owner wants links.

## Before sharing

- Put the biggest change first in its group.
- Ask your owner about anything you couldn't tell was user-facing.
- Post the draft here for editing; never publish it yourself.
`
