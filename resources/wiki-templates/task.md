---
tags:
  - topic/meta
---

# ✅ Template: task (agent-memory)

One note = one task (MT-XXXXX). Lives in `Projects/<Project>/Tasks/` — the project's single task
list. File basename: `MT-XXXXX <short name>.md` (the number is unique across the vault, so the
wikilink `[[MT-XXXXX ...]]` doesn't break). Frontmatter is for filters/Dataview; the body is a
description + an "Execution log" with append-only dated entries.

Reference for the log format: any file under `Tasks/`.

```markdown
---
tags:
  - type/task
  - project/<slug>
  - repo/<repo>              # findocs_back | custom-pricelist-api; multiple if cross-repo
  - domain/<domain>          # optional, closest business domain
  - status/<todo|in-progress|done|blocked>
task: MT-XXXXX               # task number
title: "<short name>"
services: [<service>, ...]   # which service(s)/microservice(s) this touches; can be several
branch: <git-branch>          # e.g. MT-XXXXX-short-slug; empty if there is no branch
link: <url>                  # link to the ticket (Notion/Jira); empty if none
---

# MT-XXXXX — <short name>

> <short 1-2 line description: what the task is and why.>

- **Link**: <url / —> ·
- **Branch**: `<branch / —>` ·
- **Services**: <svc1, svc2> ·
- **Status**: ✅/🔨/⚠️/❌

## Description
<what needs to be done; rules, constraints, context from the ticket.>

## Acceptance Criteria
- [ ] ...

---

## Execution log

### [YYYY-MM-DD HH:MM]

#### Task analysis
<how the task was understood and the plan of action.>

#### Reasoning
<what options were considered, why this approach was chosen.>

#### Changes
- `path/to/file` — what changed and why

#### Outcome
Status: ✅ Done / ⚠️ Partial / ❌ Blocked

<short report: what was done, what remains.>
```

## Log rules
- **Append only** to the end — do not touch or rewrite old entries.
- Each entry starts with `### [YYYY-MM-DD HH:MM]`.
- Be concrete: real file paths, functions, reasons for decisions; write plainly.
- Be honest: if blocked or only partially done, say so explicitly (`⚠️`/`❌`).
- On a status change — update `status/*` in the tags and `**Status**` in the header.
