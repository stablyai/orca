export const SKILL = `---
name: incident-timeline
description: Keep a timestamped incident timeline, then draft a blameless write-up when the incident is over.
---

# Incident timeline

## During the incident

- Add an entry for each event that matters: alert fired, someone joined, a cause was suspected or ruled out, a change was made, impact started or ended.
- Each entry: time (with time zone), what happened, link to the message or graph.
- Write facts, not judgements. Note who did something only when it matters for the timeline.

## When it is over

Draft the write-up:

1. **Summary:** what broke, for whom, and for how long.
2. **Timeline:** the entries above, trimmed.
3. **Cause:** what made it happen, and what let it reach users.
4. **What went well and what didn't.**
5. **Follow-ups:** each with an owner to be agreed.

Blameless: describe systems and decisions, never fault people. Post the draft here for your owner to edit.
`
