---
name: agent-memory
description: >-
  Use Orca's durable, project-scoped agent memory to retrieve or record cited
  architecture, constraints, decisions, facts, lessons, and completed task
  outcomes across long-running app builds. Use when work depends on prior
  project decisions, when an agent discovers stable knowledge worth preserving,
  or when newer evidence supersedes an older memory.
---

# Orca Agent Memory

This is a discovery stub. The full, version-matched guide is served by the Orca binary so its
commands and safety rules stay aligned with the installed release.

Use agent memory when a task depends on durable project decisions, architecture, constraints,
facts, lessons, or completed task outcomes from earlier agent sessions. It is project-scoped,
cited, Git-diffable, and keeps immutable history through explicit supersession.

Do not use it for secrets, raw transcripts, temporary progress, or live orchestration status.

## Resolve the CLI for this session

Choose the executable once:

- Use the value of `ORCA_CLI_COMMAND` when set.
- In a dev session exposing `ORCA_DEV_REPO_ROOT`, use `orca-dev`.
- On unmanaged Linux, use `orca-ide`; bare `orca` is normally the GNOME screen reader.
- Otherwise, use `orca`.

Below, `ORCA` is a placeholder. Replace it with the chosen executable; do not run `ORCA` literally.

## Load the full guide

```text
ORCA skills get agent-memory
```

Read that guide before writing memory. It defines retrieval-first use, citations, kinds,
confidence, supersession, workspace and SSH behavior, limits, and the boundary with orchestration.

Don't guess subcommands or flags from memory or a cached copy of this stub.
