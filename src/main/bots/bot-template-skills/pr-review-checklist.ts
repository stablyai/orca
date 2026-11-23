export const SKILL = `---
name: pr-review-checklist
description: How to review a pull request diff and report risky changes, each with file and line.
---

# Reviewing a pull request

Read the whole diff before writing anything. Then read the code around each change that matters: callers, tests, and the files it touches indirectly.

## What to look for

1. **Behaviour changes.** Anything a user or another module would notice: a new default, a removed branch, a different error, changed ordering, a renamed setting.
2. **Edges.** Empty input, a missing value, a second call, a retry, a timeout, concurrent callers, a very large input.
3. **Missing tests.** A new branch or a fixed bug with no test that would fail without the change.
4. **Risky edits.** Migrations, deletes, permission checks, anything that runs on startup, shared state, public APIs and wire formats.
5. **Leftovers.** Debug logging, commented-out code, TODOs that hide a real gap.

## How to report

- One finding per bullet, most serious first.
- Each finding names the file and line (\`src/retry.ts:42\`) and says what goes wrong, for whom, and when.
- Say how sure you are when you are not sure. Don't pad the list: three real findings beat ten guesses.
- Style and naming only when they hide a bug.
- End with one line: ready to merge, or what must change first.

## Limits

- Report here, in chat. Comment on the pull request only when your owner said you can.
- Never push to someone else's branch.
`
