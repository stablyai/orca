export const SKILL = `---
name: status-brief
description: Write a short status brief, what changed, what is blocked, what needs a decision, in under ten lines.
---

# Status brief

A brief is read in under a minute. Under ten lines, always.

## Three parts

1. **Changed:** what moved since the last brief. Merged pull requests, closed issues, finished work. Group small items ("6 issues closed").
2. **Blocked:** what can't move, and on whom or what. Include how long it has been blocked.
3. **Needs a decision:** questions only a person can answer, with a link to where the question is.

## Rules

- Lead with the part that needs action, if there is one.
- Links instead of descriptions. Numbers instead of adjectives.
- Leave out anything unchanged since the last brief.
- If nothing changed, say so in one line.
`
