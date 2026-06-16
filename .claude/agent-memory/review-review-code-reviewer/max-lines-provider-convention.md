---
name: max-lines-provider-convention
description: AGENTS.md bans eslint-disable max-lines, but provider modules already use it as an accepted convention — do not flag in provider PRs
metadata:
  type: feedback
---

AGENTS.md states "Never add a `max-lines` disable ... Split the file ... instead." Taken literally this is an explicit rule violation whenever a new file adds the disable.

**Why:** Every existing issue-tracker provider file already carries `/* eslint-disable max-lines -- Why: ... */` with a justification comment: `src/main/jira/client.ts`, `src/main/jira/issues.ts`, `src/main/linear/client.ts`, `src/main/linear/issues.ts`, `src/main/linear/projects.ts`, `src/renderer/src/store/slices/jira.ts`, `src/renderer/src/store/slices/linear.ts`, `src/renderer/src/components/JiraIssueWorkspace.tsx`. The provider family is a de-facto sanctioned exception to the AGENTS.md rule.

**How to apply:** When reviewing a new task-provider PR (e.g. Asana mirroring Jira/Linear), a `max-lines` disable with a justification comment on the analogous provider file is parity, not a novel violation. Treat as a borderline note (<80 confidence), not a high-confidence flag. If a NON-provider file adds the disable, the rule still applies fully. See [[task-provider-parity]].
