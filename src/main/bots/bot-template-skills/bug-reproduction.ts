export const SKILL = `---
name: bug-reproduction
description: Reproduce a reported bug with exact steps before looking for its cause, then report the cause.
---

# Reproducing a bug

A bug you can't make happen on purpose isn't understood yet. Reproduce first, explain second, fix last.

## Steps

1. **Collect the facts.** Version, platform, what the reporter did, what they expected, what happened. Note what is missing and ask for it once.
2. **Write the steps down** as a numbered list someone else could follow, starting from a clean state.
3. **Make it happen.** Run the steps. If it doesn't happen, change one thing at a time (platform, data size, timing, settings) and record each try.
4. **Make it small.** Remove steps until removing any more makes the bug go away.
5. **Prove it with a test** when the code has tests: a failing test is the best repro.
6. **Find where it starts.** Follow the data from the last correct point to the first wrong one. Name the file and line.

## Report

- The steps, whether they reproduce it every time or sometimes (and how often).
- The cause in one or two sentences, with file and line.
- A suggested fix and its risk. Start the fix only after your owner agrees.

If you can't reproduce it, say what you tried and what would help.
`
