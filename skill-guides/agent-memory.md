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

Orca agent memory is a provider-neutral project record stored as inspectable Markdown under
`.orca/memory`. It is for durable knowledge that should survive agent sessions and help later
tasks—not raw transcripts, hidden model state, or a replacement for Git and issue trackers.

The model follows the durable parts of
[HMLR/Dossier](https://github.com/kelvincushman/HMLR-Wiki):

- human-readable, Git-diffable memory pages;
- citations and confidence on every record;
- immutable history with explicit supersession;
- deterministic local retrieval without an embedding service;
- current knowledge by default, with historical records still inspectable.

Live task ownership and dispatch status remain in Orca orchestration. Agent memory preserves the
stable outcome, constraint, lesson, or decision that future tasks need.

## Resolve the CLI

Choose the executable once and reuse it:

- If `ORCA_CLI_COMMAND` is set, use its value.
- In an Orca development session exposing `ORCA_DEV_REPO_ROOT`, use `orca-dev`.
- On Linux outside an Orca-managed terminal, use `orca-ide`.
- Otherwise, use `orca`.

Below, `ORCA` is a placeholder for that executable. Replace it before running a command; do not
create a shell variable or run `ORCA` literally.

## Retrieval-first workflow

Before planning a large change, search using the product area, architecture term, failure, or
constraint involved:

```text
ORCA agent memory search "authentication boundary" --json
ORCA agent memory search build --kind lesson --limit 5 --json
```

Search returns compact matches with citations such as `[memory:<id>]`. Use `show` when the complete
record is needed:

```text
ORCA agent memory show <memory-id> --json
```

Treat a memory as a lead with provenance, not unquestionable truth. Read its `sources`, confirm
volatile claims against the cited source, and prefer repository or runtime evidence when they
conflict.

Search excludes superseded memories by default. Use `--include-superseded` only for history or
contradiction analysis.

## What to remember

Good records are stable, scoped, and reusable:

- an architecture boundary and why it exists;
- a user or product constraint that future work must preserve;
- a decision and the rejected alternative;
- an exact project fact with a durable source;
- a failed approach and the evidence that ruled it out;
- the durable outcome of a completed task or build phase.

Do not record:

- credentials, tokens, private keys, secrets, or personal data;
- full chat transcripts, terminal dumps, or generated chain-of-thought;
- temporary progress such as "tests are running";
- facts that can be cheaply and reliably rediscovered unless their interpretation matters;
- guesses without a source and an honest confidence level.

## Initialize

`remember` initializes the store when needed, but explicit initialization is useful during project
setup:

```text
ORCA agent memory init --json
```

The store is workspace-scoped. For an explicit target, pass `--worktree <selector>`. The same command
path works for local Git worktrees, folder workspaces, and SSH workspaces because reads and writes
use Orca's workspace filesystem provider.

## Record a memory

Every record requires a title, body, and at least one source:

```text
ORCA agent memory remember \
  --title "Authentication boundary" \
  --body "Access tokens stay in the host keychain; workspace files hold references only." \
  --kind decision \
  --confidence high \
  --source docs/security.md \
  --tag auth \
  --json
```

The backslashes above are illustrative POSIX line continuations. On PowerShell or cmd.exe, use that
shell's normal multiline syntax or put the command on one line.

For longer content already present in the workspace, use a workspace-relative file:

```text
ORCA agent memory remember --title "Build migration outcome" --body-file notes/build-outcome.md --kind task --confidence high --source issue:#123 --tag build --json
```

`--body-file` is read through the selected workspace provider, so do not convert it to a local
desktop path when the workspace is remote.

Kinds:

- `architecture` — structure, boundaries, interfaces, or ownership;
- `constraint` — requirements that bound future work;
- `decision` — a chosen approach and its rationale;
- `fact` — a concrete project fact;
- `lesson` — evidence from a failure, incident, or experiment;
- `task` — the durable outcome of completed work, not live task status.

Confidence is `low`, `medium`, or `high`. Repeat `--source` or `--tag` when needed.

## Supersede stale knowledge

Records are immutable. When evidence changes, write a new record and link the old one:

```text
ORCA agent memory remember \
  --title "Authentication boundary v2" \
  --body-file notes/auth-boundary-v2.md \
  --kind decision \
  --confidence high \
  --source docs/security-v2.md \
  --supersedes <old-memory-id> \
  --json
```

Do not edit an older record to make history look cleaner. Supersession preserves the prior claim,
the newer claim, and the reason a later agent should prefer one.

## Source conventions

Use concise references another agent can resolve:

- repository paths: `docs/security.md`, `src/auth/token-store.ts`;
- issues and pull requests: `issue:#123`, `pr:#456`;
- commits: `commit:<sha>`;
- user decisions: `user:<date-or-task-id>`;
- external sources: stable HTTPS URLs.

For a source whose content can change, mention the observed version, date, or commit in the body.

## Retrieval rules for agents

1. Search before a large design or implementation task.
2. Show the few records that materially affect the work.
3. Cite used memories as `[memory:<id>]` in plans, handoffs, or summaries.
4. Verify volatile facts against their sources.
5. Record only stable outcomes at meaningful checkpoints.
6. Supersede contradicted knowledge; do not silently overwrite it.
7. Keep orchestration task state in orchestration, not in memory.

## Limits and safety

Memory operations are bounded: record bodies, file sizes, record counts, search result counts, and
lexical scoring all have explicit caps. Symlinks are not followed when enumerating memory entries.
Writes use a temporary workspace file and a no-clobber rename so an interrupted write cannot replace
an existing immutable record.

Never copy secrets into memory merely because the directory is project-local or ignored elsewhere.
Assume `.orca/memory` may be committed and reviewed.
