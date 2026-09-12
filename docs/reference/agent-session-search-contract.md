# Agent session search contract

`AiVaultSearchRequest`, `AiVaultSearchResponse`, `AiVaultSearchHit`, and
`AiVaultSearchStatus` are defined in `src/shared/ai-vault-search-types.ts` and
validated by `src/shared/ai-vault-search-contract.ts`.

## Search and pagination

- Tool output beyond 3,072 characters per row is not indexed and not searchable; user and assistant text is indexed in full.
- A page cursor outstanding during a retention purge is refused once as `stale-cursor`; the client re-issues page 1.
- A phrase match across a chunk boundary of a long message is not supported.

`aiVault.searchSessions(request)` accepts `query`, optional `scope`
(`conversation` or `all`, default `all`), `freshness` (`indexed` or
`wait-until-current`, default `indexed`), `limit`, opaque `cursor`, `filters`,
and `debug` (default false). Conversation scope searches user and assistant text.
Filters accept `agents`, `scopePaths`, ISO `since`, and `sort` (`relevance` or
`newest`). Paths refer to the execution host and work for folders without Git.
Legacy `tier` and `refresh` fields are accepted and discarded; they do not change
the defaults. Limits use the engine's resolver: default 20, integers clamped to
1–100, fractional numbers use the default. Long queries reach the engine so it
can report truncation rather than fail validation.

Results contain `kind: 'results'`, `hits`, `page: { cursor, hasMore }`,
`generation`, `truncated: { candidates, snippets, query, freshness }`, and
`durationMs`. `snippets` is a count; the other truncation fields are booleans.
`durationMs` measures the engine search, excluding any reconciliation wait.
`debug: true` adds `debug: { route, repairedTerms?, plannerReport }`; the report
contains `route`, optional `repairedTerms`, and `scope`. Diagnostics never appear
at the top level. Status is never attached to search results.

A cursor belongs to one query and one host's index generation. Query, scope,
filters, and sorting must remain the same; page size may change. Writes that
advance the generation can invalidate it, including retention purges. A refused
cursor yields `{ kind: 'stale-cursor', generation, expectedGeneration? }` and the
client discards it and issues page 1 without a cursor. Reusing that refused cursor
continues to fail; there is no server-side cursor acknowledgement state.
Malformed cursors and cursors for a different query yield
`{ kind: 'malformed-cursor' }`. Generation checks also reject a first page if the
index changes during retrieval. Generation is a fence, not a retained snapshot:
a client cannot ask the host to recreate a previous generation.

Pages are per host only. A remote client asks one host at a time. Ordering is
local to that host's query; merged cross-host ordering and a merged cross-host
cursor are out of scope. Clients must discard cursors when changing hosts.

## Evidence and exposure

Each hit carries agent, session ID, title, cwd, branch, updated time, message
count, score, source, and evidence. Evidence contains snippet, role, and timestamp;
it is null for operator-only matches that have no text evidence. Snippet matches
use `[[` and `]]` markers. Source presence is `present`, `unverifiable`, or
`missing`; the current engine emits the first two. Loss of contact does not prove
a source missing.

`redactForTransport(hit, transport)` is the exposure policy:

| Transport                                 | filePath / codexHome                 | resumeCommand                     |
| ----------------------------------------- | ------------------------------------ | --------------------------------- |
| Desktop IPC on the same machine           | Included when known, under source    | Included only for present sources |
| Runtime RPC on the same machine           | Included when known, under source    | Included only for present sources |
| Relay or paired runtime/web/mobile client | Withheld; source keeps presence only | Withheld                          |

`cwd`, titles, snippets, and other hit metadata remain visible to paired clients.
Snippets cross the authenticated transport as indexed; this contract does not
apply an observability redactor to transcript content. A missing Codex home is
omitted. Resume commands reuse the command stored by the transcript reader,
constructed by the sidebar's `buildAiVaultResumeCommand`; this layer does not
construct commands or execute them. The runtime uses its authenticated
`clientKind` context to distinguish paired clients from same-machine RPC, never
a request-supplied locality flag. The receiving remote client also applies the
same exposure function.

## Status, freshness, and availability

`aiVault.searchStatus()` returns `enabled`, `phase` (`idle`, `indexing`, `current`,
`degraded`, or `closed`), `filesIndexed`, `filesDue`, `filesFailed`, `degradedRoots`
(`root` and `reason`), `lastReconcileAt`, `lastSweepCompletedAt`, and `generation`.
Times are milliseconds since epoch or null. These are the indexer's observations;
an indexed row is not a new filesystem verification. Status roots and reasons
are host diagnostics and remain visible to authenticated paired callers.

`wait-until-current` calls `service.reconcile()` before searching. The adapter
uses `indexer.reconcile({ full: false })`. After five seconds the endpoint searches
anyway and sets `truncated.freshness: true` on results. It does not cancel the
host's reconciliation. Completion before the deadline leaves the flag false;
a reconciliation error before the deadline propagates. The indexer's bounded
recent pass is not a promise that the entire historical corpus was swept.

Search unavailability is a value:
`{ kind: 'unavailable', reason: 'disabled' | 'not-ready' | 'no-service' }`.
No registered service returns `no-service`. Status without a service has
`enabled: false`, `phase: 'idle'`, zero counts and generation, empty degraded roots,
and null timestamps. This is a sentinel for an absent service, not a claim of an
empty, current index. A registered service may report disabled or not-ready.

## Boundaries and compatibility

- Desktop: `aiVault:searchSessions` and `aiVault:searchStatus`, via preload.
- Runtime and relay: `aiVault.searchSessions` and `aiVault.searchStatus`.
- Desktop preload optionally accepts an SSH target ID as a separate routing
  argument. It addresses exactly that relay; missing connections never fall back
  to the local index. The web preload addresses its selected paired runtime and
  rejects an SSH routing argument.

Requests and responses are parsed where received from another process. Existing
relay JSON-RPC request/response framing needs no new stream opcode. Following the
existing relay method probe pattern, an old host's explicit `-32601` refusal (or
runtime `method_not_found`) maps to `unavailable/no-service` on the client; status
uses the absent-service sentinel above. Transport failures, authentication errors,
and invalid payloads remain errors. Unknown request fields are stripped for wire
compatibility.

The process-local `setSessionSearchService(service | null)` registry is the only
production seam in this PR. Tests use fake services and a real synthetic store.
Nothing constructs an engine or indexer in production. PR 3b owns process
lifecycle, consent/settings application, and registration of the production service.
