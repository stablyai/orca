# Agent-session search across hosts

```sh
orca search --agent-session "key phrase"
orca search --agent-session "key phrase" --host runtime:server
orca search --agent-session "key phrase" --host ssh:target
orca search --agent-session "key phrase" --environment server --host ssh:target
orca search --agent-session "key phrase" --host all --json
```

The default searches the addressed runtime. `all` includes that runtime, saved
pairings on the CLI machine, and its already-connected direct SSH targets. When a
remote environment or pairing is selected, `all` includes only that runtime and
its connected direct SSH targets. It never recursively enumerates peers, connects
SSH targets, deploys a relay, or enables indexing. Connection aliases are retained;
identical paths or session IDs do not establish identical owners.

Results are grouped by host, with each host's ranking, query repairs, and coverage.
`--limit` is per host (20 by default, at most 100). Five matches on each of two
hosts return ten hits when budgets permit. Aggregate JSON includes each host's
outcome and `partial`; a failed or excluded host is distinct from a successful
query with no matches. The exit status is successful if any host completes its
query, including a zero-match query. Interrupting returns status 130.

`--agent` and `--path` repeat. Paths are literal predicates evaluated on each
execution host, with no implicit current-folder restriction. SSH/all require
absolute host-native paths, including Windows drive/UNC paths. Remote/all do not
expand `~`. A query's filters do not restrict indexing consent.

## Consent and index lifecycle

```sh
orca search --enable --history-days 90 --host ssh:target
orca search --index-status --host ssh:target
orca search --pause --host ssh:target
orca search --resume-indexing --host ssh:target
orca search --disable --clear-index --host ssh:target
```

Management always selects one host. Status cannot be combined with a query or
mutation; contradictory flags and invalid filters are rejected before mutation.
Clear with indexing enabled rebuilds the index. Disable plus clear removes it.
Pause retains searchable data while stopping new indexing.

Paired runtimes use their existing settings, scanner child, and canonical
`ai-vault-search/index.sqlite` under their data directory. Standalone `orcad`
ships the same scanner and its sibling workers. Availability checks use an
in-memory FTS5 probe, never transcript discovery. Node.js 22.13+ with `node:sqlite`
and FTS5 is required; unsupported runtimes keep ordinary runtime operations and
report search unavailable. Failed policy application is exposed as unapplied,
and explicit configuration does not acknowledge success before application and
the runtime's durable settings flush.

Plain SSH runs the existing search service inside the relay's existing low-priority
scanner child. Its account-local state lives in `~/.orca/session-search-relay`,
outside versioned relay install directories, separately from runtime profiles.
Consent defaults off and is bound to the authenticated account's default source
home. The scanner also includes the existing remote managed Codex home. Controller
environment variables and arbitrary client-supplied discovery roots are not used.

A separate stable SQLite database holds an exclusive transaction while a relay
owns the index. Other owners fail explicitly; SQLite releases the lock on process
exit. Policy is atomically persisted under that lock. After five seconds the owner
releases the index when its active requests and backfill pass finish. It does not
abort discovery or parsing to hand off: doing so can permanently starve a slow
source tree. Search, status and pause remain responsive through the same owner;
a different relay generation receives an explicit busy error until the pass
finishes or the current owner pauses. This deliberately favors a single complete
pass over periodic teardown and rediscovery. Reacquisition rereads authoritative
policy. Scanner retirement after ten idle minutes pauses work; a later search
resumes it, skipping files already current in the durable index.

Returned files are checked on the execution host for local, paired and SSH search. Confirmed missing files are
invalidated; unverifiable files are omitted with an explicit count. Raw resume
commands are labeled with the execution host and working directory. Search does
not add a cross-host resume/delete command or infer workspace identity from a
path. Provider coverage remains that of the existing indexer, including its
unindexed providers.
OpenCode rows are checked individually, so deleting or archiving one session in a
shared database does not remove the other sessions or leave the deleted hit visible.

## Routing, compatibility, and budgets

The controlling runtime forwards `aiVault.sshSearchSessions`,
`aiVault.sshSearchIndexStatus`, and `aiVault.sshSearchConfigure` through its
registered SSH provider's existing `requestHostRpc` and relay multiplexer.
Distinct targeted methods ensure an older runtime rejects the request instead
of stripping a target field and searching or clearing its own index. Existing
runtime `executionHostId` remains a label. Aggregate search requires affirmative
policy evidence; absent legacy policy is unknown and is excluded.

The CLI queries at most 16 routes with concurrency three, a 15-second host budget,
a 30-second overall deadline, and a three-second SSH inventory budget. New hosts
project replies to 512 KiB, snippets to 4 KiB, and the aggregate to 4 MiB, reporting
omissions. Cancellation travels through the existing RPC, provider, relay and
scanner cancellation paths. Already-sent mutations are not replayed after lost
acknowledgement. Synchronous SQLite work cannot be interrupted mid-statement.

## Verification

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm exec vitest run --config config/vitest.config.ts \
  src/cli/session-search-all-hosts.test.ts \
  src/main/runtime/runtime-ai-vault-ssh-search.test.ts \
  src/main/runtime/rpc/methods/ai-vault-search.test.ts \
  src/relay/session-search-owner.test.ts \
  src/relay/session-search-owner-process.test.ts \
  src/shared/ai-vault-search-projection.test.ts
```

The fixtures cover owner-separated results with colliding IDs, unknown consent,
stalled inventory, cancellation, mixed-version refusal, lease release, a real
scanner-process crash, durable consent, clear, missing transcripts, and byte limits.
Live validation also exercised the built CLI against an isolated authenticated
paired `orcad`, and a registered provider through real authenticated Docker SSH,
relay and scanner. The latter retained its relay PID and a test PTY through clear.
Native Windows/WSL and rendered desktop/web selection UI require separate live
coverage; this implementation adds the CLI surface.
