# Native task pipelines pilot

This pilot targets local Git worktrees on Orca v1.4.255. It adds an optional
pipeline picker to the normal workspace composer. Without a selection, ordinary
agent, folder, remote and linked-task creation keep their existing routes.

The runtime schedules `plan → implement → checks → docs → review`. The primary
session is reused; every reviewer gets a fresh session and a pinned clean commit.
Review findings or failed checks return to `fix → checks → docs → review`, with a
shared maximum of two fix cycles. Readiness means evidence is current and the
review passed; it does not merge, deploy or close the issue.

## Isolated development

Build the CLI and desktop with the repository's pinned Node/pnpm versions. Use
`ORCA_BACKGROUND_LAUNCH=1` for agent-launched processes. Set an explicit
`ORCA_DEV_USER_DATA_PATH` and use this checkout's `config/scripts/development/launch/orca-dev.mjs`.
Never install over the production application or point a pilot at its profile.
Plain Node `orcad` does not initialize the desktop plugin service on this base;
this pilot uses the desktop runtime, including Electron serve mode.

Load `examples/plugins/task-pipelines` through `orca plugin dev load`. Review and
approve its exact fingerprint in the isolated profile. It declares profiles and
a sandboxed panel, with `workspace:read`; its controls are limited to its own
profiles, audited, and require an owner gesture. It has no shell or worker code.
Enable the plugin system if needed. The profile pins agent/model/effort settings;
the example uses the configured Codex default for both roles in distinct sessions.

Before starting, configure project checks using an owner-authored JSON file:

```json
{
  "projectId": "<Orca repo ID>",
  "checks": [
    { "id": "test", "program": "/absolute/path/to/node", "args": ["--test"], "timeoutMs": 60000 }
  ]
}
```

Run `orca pipeline configure --input-file <file> --json`. Programs and arguments
are literal trusted configuration, never task-generated shell. Admission saves
the approved profile, provider fingerprint and check definitions before creating
the worktree. Changes to configuration affect subsequent runs. A changed or
disabled provider pauses further execution until the exact approval is restored.

Choose the profile through project **+**, or use:

```sh
orca pipeline profiles --json
orca worktree create --repo id:<repo> --name <name> --pipeline local.task-pipelines/standard-development --request-id <stable-request-id> --comment '<task criteria>' --json
```

The pipeline owns agent startup. Setup must settle before the first dispatch;
ordinary startup agents and default tabs cannot start a competing agent. Reusing
the same creation request returns the bound worktree; an uncertain create stops
for inspection. Open **Task Pipelines** from the plugin panels to inspect runs.

## Evidence and recovery

`orca pipeline describe --json` publishes version 1 schemas, policies and limits.
Use `list`, `status` and `context`; explicit artifact stage/index selectors read
history without copying the entire transcript. Storage lives under private
`userData/pipelines/runs.sqlite`, separate from checkout and general memory.
An artifact is at most 12,000 characters, structured stage evidence at most
4,000, with bounded task/context packages and a maximum of 50 active runs.

Agents submit through `pipeline submit --input-file <file>`, then report native
worker completion. The runtime validates the active attested Dispatch, workspace
instance, input revision and actual source fingerprint. Plan criteria, change
lists, documentation files/rationale and review findings are structured evidence;
they do not prove semantic correctness by themselves. Native checks supply their
own results. Documentation file claims must refer to actual task changes.

Pause controls future dispatches; an active worker may still submit evidence.
`pause`, `resume` and `revalidate` require a stable request ID and expected revision.
`receipt` reads the exact saved mutation receipt without repeating it. After
source edits invalidate readiness, `revalidate` returns to checks/docs/review
without resetting the fix budget.

Unknown launches, incomplete checks and source changes during checks stop for
reconciliation. `reconcile` releases only workers or check transports proven to
have settled; it does not blindly restart a possibly running mutation. Inspect
unknown processes before recovery. `resume` cannot bypass an unresolved effect
or setup hold. `reconcile --setup-terminal <handle>` can attach a proven setup
terminal belonging to the same workspace. No operation grants merge/deploy rights.

The owner-configured check process timeout is bounded to ten minutes. There is no
verified token or currency cap. Evaluate elapsed time, available native usage,
owner interventions and defects on representative tasks before regular use.

## Companion assistant catalog

The companion Personal Platform adapter registers versioned `orca.pipeline.*`
read/control tools with project grants, confirmation, runtime identity pinning,
revision checks and read-only recovery. It defaults to disabled. Configuration
and worker submission remain owner/native-worker operations; model tools cannot
install profiles, choose arbitrary checks or impersonate stage workers.

One-shot filesystem privacy checks at lazy runtime/store initialization have
reviewer approval in `config/main-sync-fs-baseline.txt`. They must not migrate into
repeated RPC, pump or polling paths.
