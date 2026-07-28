# Orchestration Structured Worker Output

Status: implemented; physical local, mixed-version, and Windows-home to Mac-worker validation complete
Scope: orchestration `worker-read` only
Last updated: 2026-07-24

## Summary

`orca orchestration worker-read` currently reads bounded terminal output. That is always available,
but full-screen agent TUIs can make it noisy or incomplete.

Orca already knows more than the terminal logo suggests. Agent hooks associate an exact pane with:

- the agent type, such as Codex or Claude;
- the provider session or conversation ID; and
- when available, the provider-reported transcript path.

The sidebar, session resume, sleeping-agent recovery, and native chat already use this information.
The missing piece is a narrow orchestration path from an exact Dispatch to that exact session on the
server where the worker runs.

The proposed behavior is:

```text
worker-read
  exact supported transcript is available -> structured transcript page
  otherwise                               -> bounded terminal page
```

This does not add orchestration strategy, a dashboard, a scheduler, or a universal provider layer.
It makes one existing observation command return the best source Orca can prove.

## User-facing goal

A coordinator should be able to inspect a worker with one predictable command:

```bash
orca orchestration worker-read --dispatch <dispatch-id> --json
```

The coordinator should not need to know:

- which Orca server owns the worker;
- the worker's terminal or pane handle;
- the provider session ID;
- where a transcript lives on disk; or
- whether structured reading is supported by that provider/server version.

The response must always say which source was used. It must never silently read a different agent
session.

## Why the existing sidebar is relevant

The agent logo identifies the detected agent type. By itself, that is not enough to choose a
transcript.

The richer sidebar status also carries pane-scoped provider-session metadata reported by hooks.
That is the useful foundation:

```text
Dispatch
  -> exact worker process and terminal
  -> exact tab/leaf pane
  -> hook-reported provider session
  -> provider transcript locator
```

Some live status ownership is currently renderer-centric, while headless and mobile graph paths
also retain compatible status snapshots. Implementation therefore needs one runtime-owned lookup
that exposes the current exact pane association to `worker-read`. This is a small bridge over
existing status data, not a second agent-status system.

## Design principles

### Exactness over convenience

- Never select the "latest session in this directory."
- Never select a transcript from a terminal title or logo alone.
- Never switch sources or sessions in the middle of a cursor chain.
- If Orca cannot prove the association, return a labeled terminal fallback.

### Resource-local reads

The server running the worker resolves and reads its transcript. A Run home on macOS must not try
to interpret a Windows path, and a Windows Run home must not try to interpret a macOS path.

Only bounded output data crosses the federation connection. Transcript paths do not.

### One simple agent command

Agents should not choose provider adapters or supply session metadata. `worker-read` defaults to
automatic source selection. Source selection flags exist for debugging and explicit policy, not
because they are required in the normal loop.

### Narrow provider support

Initial support should cover only providers for which Orca already has:

1. an exact pane-scoped session association; and
2. an existing bounded transcript reader with test coverage.

Codex is the required first provider. Claude may ship in the same change only if it uses the same
proven reader path without adding a second architecture. Other agents receive terminal fallback.

### Honest compatibility

Connected servers can run different Orca versions. A server without structured-read support must
continue to return bounded terminal output rather than failing the whole Run.

## Public command contract

### Request

```bash
orca orchestration worker-read \
  --dispatch <dispatch-id> \
  [--source auto|transcript|terminal] \
  [--cursor <opaque-cursor>] \
  [--limit <count>] \
  [--json]
```

`--source` behavior:

| Value        | Behavior                                                                               |
| ------------ | -------------------------------------------------------------------------------------- |
| `auto`       | Use an exact supported transcript; otherwise use terminal output. This is the default. |
| `transcript` | Require an exact supported transcript. Return a typed error instead of falling back.   |
| `terminal`   | Use the current bounded terminal reader.                                               |

Existing numeric terminal cursors remain accepted. New responses return an opaque cursor that can
pin either source without exposing provider paths.

### Response

The implemented structured response has this shape:

```json
{
  "dispatchId": "dispatch_123",
  "source": "transcript",
  "sourceIdentity": "opaque-source-fingerprint",
  "provider": "codex",
  "transcript": {
    "messages": [],
    "nextCursor": "opaque-next-cursor",
    "limited": false,
    "returnedMessageCount": 0
  },
  "cursor": "opaque-next-cursor",
  "status": {
    "worker": "running",
    "terminal": "running"
  },
  "fallbackReason": null,
  "warnings": []
}
```

Terminal fallback uses the same envelope and keeps the existing terminal data:

```json
{
  "dispatchId": "dispatch_123",
  "source": "terminal",
  "sourceIdentity": "opaque-terminal-incarnation",
  "terminal": {
    "tail": ["..."],
    "status": "running",
    "nextCursor": "..."
  },
  "cursor": "opaque-next-cursor",
  "fallbackReason": "session_not_reported",
  "warnings": []
}
```

For backward compatibility:

- the terminal branch retains the existing `terminal.tail`, `terminal.status`, and
  `terminal.nextCursor` fields;
- non-JSON output prints readable transcript entries or terminal lines without requiring an agent
  to branch on JSON manually;
- a mixed-version federated read can return the legacy terminal shape, which the Run home wraps as
  a labeled terminal response.

### Fallback reasons

Fallback reasons are bounded typed values, not arbitrary policy:

- `provider_unsupported`
- `session_not_reported`
- `transcript_missing`
- `transcript_unreadable`
- `transcript_parse_failed`
- `remote_capability_unavailable`

Warnings may provide safe diagnostic context, but must not contain a remote filesystem path.

### Typed errors

Errors are used when returning any source would be misleading:

- `dispatch_not_found`
- `worker_identity_changed`
- `source_changed`
- `cursor_invalid`
- `cursor_dispatch_mismatch`
- `transcript_required`
- the existing connected-server unavailable/unknown result

`source_changed` means the exact pane is now associated with a different provider session than the
one pinned by the cursor. The caller starts a new read without the old cursor. Orca never silently
jumps to the replacement session.

## Source identity and cursor rules

The cursor is opaque to clients and contains only non-sensitive routing data:

- cursor version;
- Dispatch ID;
- source kind;
- an opaque digest of the exact source identity;
- provider-specific or terminal paging position.

It must not contain a transcript path.

On every continued read, the worker server:

1. revalidates the Dispatch's exact process attachment;
2. resolves the current pane/session association;
3. compares its source digest with the cursor;
4. reads only when they still match; and
5. otherwise returns `source_changed` or `worker_identity_changed`.

The cursor is source-pinned even when the request uses `--source auto`. `auto` chooses only on the
first page.

The implementation uses a versioned stateless token. The token is not an authority credential:
every read revalidates the Dispatch, process, pane, source digest, and provider session before
returning data. This lets paging survive an Orca restart without adding cursor-secret persistence.

## Runtime architecture

### 1. Resolve the Dispatch at its Run home

The Run home remains authoritative for Task and Dispatch state. It looks up the Dispatch and its
pinned worker server exactly as `worker-show` and the current `worker-read` do.

No automatic placement or server selection is added.

Current implementation anchors:

- `src/main/runtime/rpc/methods/orchestration-worker-control.ts` owns local and federated
  `worker-read` routing.
- `src/main/runtime/rpc/methods/orchestration-worker-observation.ts` validates the exact attached
  worker.
- `src/cli/handlers/orchestration.ts` owns the current CLI request and terminal rendering.

### 2. Route the read to the worker server

For a local worker, the Run home and worker server are the same runtime.

For a federated worker, the Run home calls the existing federation read route on the server pinned
to the Dispatch. The request contains the Dispatch ID, source preference, cursor, and limit—not a
terminal handle, session ID, or transcript path chosen by the coordinator.

### 3. Revalidate the exact worker

The worker server uses the existing Dispatch attachment to verify:

- the exact managed pane;
- the exact terminal/process incarnation; and
- that the Dispatch has not been replaced, stopped, or detached.

This preserves the same no-cross-worker rule already used by worker lifecycle and terminal reads.

### 4. Resolve the pane's provider session

Add one runtime-owned resolver that returns a snapshot similar to:

```ts
type ExactWorkerProviderSession = {
  paneKey: string
  agent: TuiAgent
  providerSession: AgentProviderSessionMetadata
  observedAt: number
}
```

The resolver may use the current runtime graph/headless retained status, but it must accept the
Dispatch's exact pane identity as input. It must not search all sessions by working directory or
agent type.

The source association is considered usable only when:

- it belongs to the Dispatch's exact current pane/process;
- the hook metadata is fresh enough to belong to that process incarnation;
- the provider session metadata passes existing normalization/canonicalization; and
- a supported adapter can resolve an exact transcript.

If these checks fail under `auto`, the read falls back to terminal output.

Current session/status anchors:

- `src/shared/agent-session-resume.ts` defines normalized provider-session metadata.
- `src/renderer/src/store/slices/agent-status.ts` maintains pane-scoped live agent status.
- `src/shared/runtime-types.ts` carries compatible agent status in runtime/mobile graph snapshots.
- `src/main/runtime/orca-runtime.ts` preserves provider-session metadata when it publishes those
  snapshots.

### 5. Read through a narrow adapter

Reuse the existing bounded native-chat transcript parser rather than adding another parser stack.
Extract or wrap its pure reader behind a small orchestration adapter:

```ts
type WorkerTranscriptReader = {
  provider: 'codex' | 'claude' | 'openclaude' | 'grok'
  readPage(input: ExactTranscriptRead): Promise<ExactTranscriptPage>
}
```

This is deliberately not a registry for every possible agent capability. Add an adapter only when
an exact locator and a tested reader already exist.

Current reader anchors:

- `src/main/native-chat/transcript-watch.ts` provides bounded transcript reads/subscriptions.
- `src/main/runtime/rpc/methods/native-chat.ts` exposes the existing reader over runtime RPC.
- `src/main/ipc/native-chat.ts` exposes the same reader to the desktop renderer.

The transcript response should preserve the existing structured message/block representation and
the supported fields that the proven reader already understands. Unknown or skipped input should
produce parsing warnings rather than being silently presented as a complete transcript.

### 6. Return bounded data

Every path enforces:

- at most 50 transcript messages per page (40 by default);
- a maximum serialized response size;
- existing clipping/redaction rules for large tool input and output;
- opaque projection of transcript-position fallback IDs and redaction of Dispatch capability tokens;
- deterministic pagination; and
- no transcript path leakage.

Transcript observation is read-only. A failure or unknown network result must never trigger worker
restart, retry, stop, or Task mutation.

## Federation and cross-platform behavior

The core topology is:

```text
Mac Run home
  -> authenticated connected-server RPC
  -> Windows worker server
  -> exact Windows pane/session
  -> Windows-local transcript reader
  -> bounded structured page back to Mac
```

The reverse direction must work identically.

Platform rules:

- Use Node path operations only on the server that owns the path.
- Do not normalize Windows paths on macOS or macOS/Linux paths on Windows.
- SSH and WSL execution remain behind their owning Orca server.
- If the exact transcript is accessible only on an SSH/WSL execution host, the worker server must
  use an existing host-aware read mechanism or fall back to terminal. Do not copy the path to the
  Run home.
- Mixed-version capability negotiation applies only at the Orca server protocol boundary.
- A server that does not advertise structured worker read receives the existing terminal-read RPC.

Federation adds one narrow additive RPC, `orchestration.federationReadOutput`. The Run home probes
it by calling it. If the worker server returns `method_not_found`, the Run home calls the existing
`orchestration.federationRead` terminal method and wraps that result as a labeled
`remote_capability_unavailable` fallback. No generalized capability matrix is added.

## Lifecycle behavior

### Provider session appears after worker start

Hooks may report a session after the TUI becomes ready. An initial `auto` read may therefore return
terminal output. A later first-page `auto` read may select transcript output.

Once a cursor is returned, that cursor remains pinned to its selected source.

### Provider session changes

Compaction, resume, or process replacement may produce a new provider session:

- a fresh read without a cursor may select the new exact session;
- a cursor for the old session returns `source_changed`;
- Orca does not merge the old and new transcripts implicitly.

### Orca restart

After restart, the worker server re-establishes the exact pane/process association using the same
runtime graph and retained-hook mechanisms used by sidebar/session recovery.

- If exact identity and session still match, paging continues.
- If process identity is uncertain, return `worker_identity_changed`.
- If only transcript identity is unavailable, `auto` may start a new terminal page but must not
  reinterpret an old transcript cursor as a terminal cursor.

### Disconnect

A disconnected federated read is a read-only unknown result. Reissuing the same read is safe.
No mutation request ledger, durable outbox, automatic failover, or worker replacement is needed.

## Implementation plan

### Work package 1 — Correct the contract and types

- Update the orchestration checklist to replace the inaccurate claim that exact pane-to-session
  association does not exist.
- Add the source preference, response envelope, fallback enums, and opaque cursor types.
- Keep the existing terminal response fields compatible.
- Add the CLI `--source` option and accept both legacy numeric and new opaque cursors.

Exit gate: contract tests cover legacy terminal JSON and the new labeled envelopes.

### Work package 2 — Runtime exact-session resolver

- Add a runtime method that resolves agent status for an exact Dispatch pane/process.
- Reuse the existing graph/headless retained status and provider-session normalization.
- Reject stale pane or process-incarnation associations.
- Test multiple panes and multiple sessions in the same worktree and directory.

Exit gate: the resolver can never return a sibling pane's session.

### Work package 3 — Codex transcript adapter

- Reuse the current bounded native-chat Codex reader.
- Add deterministic page conversion and parsing warnings.
- Enforce entry and byte limits.
- Produce a path-free source identity digest and cursor.
- Add Claude only if it follows this same path without new infrastructure.

Exit gate: exact Codex transcript pages are stable, bounded, and contain no local path.

### Work package 4 — Local `worker-read`

- Resolve and validate the exact worker.
- Implement `auto`, `transcript`, and `terminal`.
- Pin the source across cursor pages.
- Preserve the existing terminal fallback and non-JSON rendering.

Exit gate: local dogfood proves correct selection with several simultaneous same-directory Codex
sessions.

### Work package 5 — Federated `worker-read`

- Add the narrow connected-server capability.
- Route transcript resolution and reading to the worker server.
- Wrap legacy remote terminal responses as labeled fallbacks.
- Reject mismatched Dispatch/server/session cursors.
- Ensure paths and internal server identity remain out of ordinary output.

Exit gate: physical Mac-to-Windows and Windows-to-Mac reads both pass.

### Work package 6 — Restart, fallback, and documentation

- Cover runtime restart, renderer restart, disconnect, stale status, missing hooks, unreadable
  transcript, unsupported providers, and mixed server versions.
- Update CLI help, the orchestration skill, and the implementation checklist.
- Dogfood the common coordinator loop using only the documented commands.

Exit gate: every fallback is truthful and no fallback changes worker lifecycle state.

## Validation plan

### Unit and contract tests

| Area                  | Required proof                                                                       |
| --------------------- | ------------------------------------------------------------------------------------ |
| Exact resolution      | A Dispatch resolves only its attached pane and process incarnation.                  |
| No directory guessing | Two Codex sessions in the same worktree cannot cross-read.                           |
| Source choice         | `auto` prefers an exact supported transcript and otherwise labels terminal fallback. |
| Explicit source       | `transcript` fails truthfully when unavailable; `terminal` never probes transcript.  |
| Cursor pinning        | Continued pages stay on the same source and provider session.                        |
| Session replacement   | An old cursor returns `source_changed`.                                              |
| Cursor custody        | A cursor for another Dispatch is rejected.                                           |
| Parsing               | Malformed/skipped transcript records produce bounded warnings.                       |
| Limits                | Entry count, block size, and total serialized response are bounded.                  |
| Privacy               | Responses and cursors contain no transcript path.                                    |
| Compatibility         | Existing terminal fields and numeric cursors continue to work.                       |

Likely focused test locations:

- provider-session normalization and pane association tests;
- native-chat transcript reader tests;
- orchestration worker-control RPC tests;
- orchestration worker CLI tests; and
- federation protocol and physical harness tests.

### Local integration scenarios

1. Start a Codex worker and confirm the sidebar reports its provider session.
2. Read the Dispatch and verify `source=transcript`.
3. Start two Codex workers in the same worktree.
4. Give them distinct prompts and verify neither read contains the other's content.
5. Page both transcripts and verify stable source identities.
6. replace or resume one session and verify its old cursor returns `source_changed`.
7. Disable hooks and verify a labeled terminal fallback.
8. Remove or make the transcript unreadable and verify a safe fallback or
   `transcript_required`, depending on the requested source.

### Physical federation matrix

| Run home | Worker server | Worker location | Required outcome                                                |
| -------- | ------------- | --------------- | --------------------------------------------------------------- |
| macOS    | Windows       | native Windows  | Exact structured page or labeled supported fallback             |
| Windows  | macOS         | native macOS    | Exact structured page or labeled supported fallback             |
| macOS    | macOS/Linux   | SSH host        | Exact host-aware page or terminal fallback without path leakage |
| Windows  | Windows       | WSL             | Exact host-aware page or terminal fallback without path leakage |

For both Mac/Windows directions:

- run multiple workers at once;
- page beyond the first response;
- restart the Run home;
- restart the worker server;
- disconnect and reconnect the server;
- verify mixed-version fallback with one server lacking the new capability; and
- compare the selected provider session with the sidebar/native-chat session for the same pane.

### Dogfood procedure

The dogfood is successful only if a coordinator can follow this loop without internal IDs:

1. Create/use a Run.
2. Start one local worker and one connected-server worker.
3. Wait for both starts to settle.
4. Call `worker-read --source auto` for each Dispatch.
5. Continue each cursor through at least two pages.
6. Confirm output belongs to the correct prompt and machine.
7. Trigger one fallback case.
8. Complete both workers and confirm reads never altered lifecycle state.

Record:

- command and response;
- chosen source and fallback reason;
- worker server/platform;
- provider and session match;
- cursor behavior;
- path-leak check;
- restart/disconnect outcome; and
- any agent confusion using only CLI help and the orchestration skill.

## Acceptance criteria

Implementation is complete only when:

- `worker-read` selects an exact transcript or returns a clearly labeled terminal fallback.
- No test or dogfood scenario reads a sibling or previous provider session.
- A cursor never switches source or provider session silently.
- Mac-to-Windows and Windows-to-Mac physical reads pass.
- Runtime restart and disconnect behavior are safe and understandable.
- Unsupported agents and mixed versions retain useful terminal output.
- Transcript paths never leave the server that owns them.
- Existing terminal-read clients remain compatible.
- The common agent path remains one command with no server/session/path inputs.
- No UI, scheduling, retry, integration tracking, or generalized provider framework is added.

## Explicit non-goals

- No dashboard or sidebar changes.
- No coordinator chat changes.
- No automatic worker placement, retry, replacement, or recovery.
- No commit, test, branch, merge, or integration tracking.
- No provider-session locking or resume orchestration.
- No live transcript subscription in the orchestration API.
- No universal transcript/event ontology.
- No cross-server filesystem access from the Run home.
- No replicated Run database or automatic Run-home failover.
- No generalized access-control or capability framework.

## Main risks and mitigations

| Risk                                           | Mitigation                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Live session status is stale or renderer-owned | Resolve through a runtime-owned exact-pane snapshot and bind it to process incarnation.           |
| Two sessions share a directory                 | Never use directory/latest-session lookup; require exact pane/session metadata.                   |
| A session changes between pages                | Pin source identity in the cursor and return `source_changed`.                                    |
| Remote path is meaningless or sensitive        | Read only on the worker server and never serialize the path.                                      |
| Transcript parser drops data                   | Preserve supported structured blocks and return parsing warnings.                                 |
| Transcript metadata exposes a path/credential  | Make file-position IDs opaque and redact Dispatch capabilities from all structured text/payloads. |
| Mixed server versions                          | Negotiate one narrow capability and fall back to existing terminal read.                          |
| Full-screen terminal output remains noisy      | Prefer structured output only when exact; retain terminal as the universal safety path.           |
| Scope expands into a provider platform         | Ship Codex first and require proven exact association plus an existing reader for every addition. |

## Decision

Implement structured worker output as a narrow extension of `worker-read`.

The prerequisite is not a new sidebar or status system: Orca already tracks exact pane-scoped
provider sessions. The work is to make that existing association available to the worker-owning
runtime, read the transcript locally through proven readers, pin pagination to that source, and
federate only the bounded result.
