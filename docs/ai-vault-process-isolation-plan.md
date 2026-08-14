# AI Vault process isolation architecture and implementation plan

Status: implemented behind the documented desktop/runtime kill switch, with local build, parity, Electron, and A/B validation complete.

Last updated: 2026-08-09.

## Decision summary

AI Vault will remain part of the integrated Orca renderer, but its host-side work will move behind a persistent service-process boundary.

The target has three rules:

1. The desktop and Orca runtime route local Vault scans and title resolution to one lazy, supervised Vault service process per host process.
2. The SSH relay routes Vault work to a relay-side Vault service process. The relay event loop that handles PTYs must not scan or parse Vault data.
3. The renderer publishes completed Vault results at low priority after terminal input is quiet. xterm and the Vault panel remain in the same renderer.

This is deliberately not a separate `WebContentsView`, window, or embedded app. The measurements below show bounded CPU contention under an exaggerated scan, but no renderer long tasks and no evidence that a second Chromium renderer is justified.

The public Electron IPC, runtime RPC, and SSH relay method names and result meanings remain unchanged in the initial migration. The process boundary is host-internal.

## Goals

- A Vault scan, parser fault, cache fault, or memory spike cannot crash the terminal daemon, relay PTY loop, Electron main process, or runtime host.
- Terminal input remains responsive while a local, runtime, or SSH Vault refresh is active.
- Vault work has bounded concurrency, queue depth, memory, result size, cancellation latency, and wall time.
- The service can be restarted without restarting the app, runtime, relay, or terminals.
- Existing local, folder-workspace, WSL, runtime, and SSH behavior remains compatible.
- Mixed-version remote peers continue to work.
- The architecture is conventional and debuggable: integrated UI, thin routers, dedicated background services.

## Non-goals

- Treating the service process as a security sandbox. It runs trusted Orca code with the same user identity.
- Rewriting the scanner or changing session discovery semantics during the process migration.
- Moving xterm into another renderer.
- Adding a process per window, worktree, repository, or SSH request.
- Removing the old-relay compatibility fallback in the same change.
- Making pagination a public wire dependency before mixed-version fallback behavior exists.

## Current architecture and coupling

| Path                                    | Current execution                                                            | Remaining coupling                                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Desktop local scan and title resolution | Persistent `worker_threads.Worker` from `session-scanner-worker-spawn.ts`    | Separate V8 isolate, but the same OS process, priority class, failure domain, and overall memory accounting as Electron main |
| Orca runtime scan and title resolution  | The same worker client used by runtime RPC methods                           | Same-process CPU, memory, and lifecycle coupling with the runtime host                                                       |
| SSH relay scan and title resolution     | `AiVaultHandler` calls the remote scanner and title reader inside `relay.ts` | Vault discovery, reads, parsing, cache work, and PTY routing share one event loop and process                                |
| Old SSH relay fallback                  | Desktop main crawls the host through the SSH filesystem provider             | Compatibility path can consume desktop and SSH multiplexer work; complete remote isolation is impossible without a new relay |
| Renderer result publication             | `setScanResult(result)` and `setSessions(result.sessions)` immediately       | Deserialization, projection, filtering, grouping, and React rendering share the renderer thread with xterm                   |

The current local worker already provides meaningful isolation. It allows one active request, bounds the queue at 16, supports cancellation, and uses 130-second scan and 15-second title timeouts. The migration should preserve those properties instead of replacing them with an unbounded child-process API.

The terminal backend is already a detached daemon process. A Vault service beside it fits the existing process model; it does not require a terminal redesign.

## Feature-parity contract

The migration changes execution ownership only. Unless a separate product change is approved, the service-on and worker-fallback paths must be observably equivalent after normalizing `scannedAt` and process metrics.

| Capability            | Required behavior after migration                                                                                                                                                                                       | Owner                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Agent discovery       | Preserve every `AI_VAULT_AGENTS` source: Claude, Codex, Hermes, Pi, OMP, Prime Agent, Cursor, Gemini, Antigravity, Rovo Dev, Copilot, OpenCode, Grok, OpenClaw, Devin, Droid, and Kimi                                  | Service scanner, using existing source adapters                             |
| Session result        | Preserve every `AiVaultSession` field, including host/platform identity, paths, Codex home, timestamps, previews, token/message counts, queued/recoverable state, subagent count, resume command, and subagent metadata | Service result builder; router validates/restamps only where it does today  |
| Scope and depth       | Preserve workspace/project/all scoping, guaranteed older in-scope sessions, 250/500/1000/unlimited depth, sorting, deduplication, and issue rows                                                                        | Service per-host scan; router multi-host merge; renderer view projection    |
| Host routing          | Preserve local, all-host, individual SSH, and individual runtime selection with the same per-host time budgets and partial-failure issue behavior                                                                       | Router                                                                      |
| Dynamic roots         | Preserve environment overrides, managed/per-account Codex homes, runtime Codex homes, WSL default and Orca-owned homes, and every platform-specific agent root                                                          | Router resolves dynamic homes per request; service discovers within them    |
| Refresh semantics     | Preserve TTL reuse, force refresh, request-token cancellation, force preemption, coalescing, window-focus refresh, and new-agent-session refresh throttling                                                             | Router coordinator plus service cancellation                                |
| Title synchronization | Preserve local, SSH, and runtime Claude/Codex title resolution and the existing input-quiet tab-title gate                                                                                                              | Service title operation plus existing host routing                          |
| Subagent expansion    | Preserve local-only Claude and OMP child listing, path containment, status, issue rows, and retry behavior. Runtime/SSH/web remain empty until a separately negotiated feature exists                                   | Service interactive operation; router retains current host gate             |
| First-prompt copy     | Preserve local-only on-demand full prompt parsing, OpenCode row lookup, truncation safety, injected-turn suppression, and preview fallback. Runtime/SSH/web remain preview-only                                         | Service interactive operation; router retains current host gate             |
| Resume                | Preserve provider-specific resume commands, Codex-home preparation, account targeting, execution-host targeting, platform quoting, OMP path resume, drag/drop, and new-tab launch                                       | Existing router/renderer paths; they consume an unchanged session result    |
| Logs and live state   | Preserve View Log/Open Log, reveal/copy path, working-directory action, read-only editor behavior, live tail, original-pane jump, and worktree jump                                                                     | Existing filesystem/editor/native-chat paths; outside the service migration |
| Delete                | Preserve local-only gating, liveness checks, OS trash/WSL deletion, companion artifacts, idempotency, and rejection reasons                                                                                             | Trusted router executor; invalidate router and service caches on success    |
| View behavior         | Preserve search, agent toggles, sort/group, hide-empty/recoverable-empty logic, persisted view options, collapsed groups, and host/scope controls                                                                       | Renderer; unchanged apart from publication scheduling                       |
| Compatibility         | Preserve current web/runtime limitations, old-relay fallback, mixed-version result meaning, and unavailable-host issue rows                                                                                             | Router and existing public transports                                       |

Add a backend-equivalence suite that runs the same golden corpus through the current worker and the service process, normalizes only `scannedAt`, and deep-compares the complete results. The corpus must cover every agent, OpenCode SQLite and legacy formats, append-only incremental parsing, recoverable empty sessions, Claude/OMP subagents, managed Codex homes, duplicate Codex roots, WSL-shaped roots, scope inclusion, corrupt/partial files, and issue overflow.

No field may be dropped to reduce IPC size during the migration. Any later payload reduction requires an independently versioned compatibility plan because resume, drag/drop, log actions, and project ownership consume fields that may not be visibly rendered in the list.

## Target topology

```text
Desktop / runtime host

  Integrated renderer
    ├─ xterm UI ─────────── terminal IPC/router ───────── terminal daemon
    └─ AI Vault panel ───── Vault IPC/RPC router ──────── Vault service process
                               │
                               └─ host merge + compatibility routing

SSH execution host

  Desktop ── existing SSH Vault RPC ── relay router ───── Vault service sidecar
                                      └────────────────── PTY handler/event loop
```

The two relay branches share only the relay's bounded request/response routing. Filesystem discovery, transcript reads, JSON parsing, SQLite access, parse caches, and title caches execute in the sidecar.

## Process ownership

- Desktop: one Vault service per Electron main process, shared by every window and workspace.
- Orca runtime: one Vault service per runtime host process, shared by all connected clients.
- SSH relay: one Vault service per live relay daemon, shared across relay reconnects and requests.
- WSL: preserve current source ownership initially. The Windows local service invokes the existing WSL-aware adapters; do not add a process per distro in this migration.
- Old relay: retain the bounded desktop fallback only when the relay method is unavailable. A new relay whose sidecar fails must return an issue instead of scanning inline on the relay loop.

## Service responsibilities

The service owns:

- Source discovery and filesystem metadata reads.
- Transcript streaming and parsing for all supported agents.
- OpenCode SQLite reads and its nested worker lifecycle.
- In-memory and persisted session parse caches.
- The bounded title index and transcript title resolution.
- On-demand Claude/OMP subagent listing and full first-user-prompt extraction.
- Scan parse concurrency and cooperative cancellation.
- Result construction, deduplication, sorting, and internal paging.
- Per-request metrics that contain counts and timings, not session content.

The router owns:

- Electron IPC, runtime RPC, or relay method registration.
- Authentication and connection ownership already enforced by that transport.
- Public argument validation and execution-host selection.
- Resolution of dynamic host inputs such as managed Codex homes and WSL distro homes; resolved roots are passed with each scan so a long-lived service cannot retain stale account configuration.
- Multi-host result merging.
- Request coalescing and mapping caller cancellation to the service request.
- Validation of service responses before publishing them across a public boundary.
- Compatibility fallback selection.
- Local deletion, liveness checks, OS trash integration, and cache-invalidation commands sent to the service after a successful mutation.

The renderer owns only view state, filtering/grouping of the returned page, user actions, and low-priority result publication.

## Internal process protocol

Add a versioned, private protocol in `src/main/ai-vault/session-scanner-service-protocol.ts`. It is not a remote wire protocol.

Parent to service:

```ts
type ServiceRequest =
  | { type: 'init'; protocol: 1; host: HostDescriptor; cache: CacheOptions }
  | { type: 'request'; id: number; operation: 'scan'; options: ScanOptions }
  | { type: 'request'; id: number; operation: 'titles'; requests: TitleRequest[] }
  | { type: 'request'; id: number; operation: 'subagents'; request: SubagentRequest }
  | { type: 'request'; id: number; operation: 'firstPrompt'; request: FirstPromptRequest }
  | { type: 'invalidate'; paths: string[]; generation: number }
  | { type: 'cancel'; id: number }
  | { type: 'shutdown' }
```

Service to parent:

```ts
type ServiceResponse =
  | { type: 'ready'; protocol: 1; pid: number; capabilities: ServiceCapabilities }
  | { type: 'result'; id: number; operation: 'scan'; value: ScanPage; metrics: ScanMetrics }
  | { type: 'result'; id: number; operation: 'titles'; value: TitlesResult }
  | { type: 'result'; id: number; operation: 'subagents'; value: SubagentListResult }
  | { type: 'result'; id: number; operation: 'firstPrompt'; value: FirstPromptResult }
  | { type: 'invalidated'; generation: number }
  | { type: 'error'; id: number; code: ServiceErrorCode; message: string; retryable: boolean }
  | { type: 'fatal'; code: ServiceErrorCode; message: string }
```

Protocol rules:

- Validate every incoming and outgoing message. Ignore an unknown response ID and terminate on a protocol-version mismatch.
- Use monotonically increasing safe-integer request IDs scoped to the child lifetime.
- Preserve the existing shared limits for request counts, scope-path count and length, title requests, and session depth.
- Keep one cache-mutating lane for scans and title resolution, plus one independent interactive-read lane for subagent and first-prompt reads. Title resolution stays serialized with scans because both mutate the shared parse/title caches; the independent operations do not. Queue at most 16 calls across both lanes.
- Coalesce equivalent scans. Replace an older queued background scan with the newest one.
- Queue priority is first-prompt/subagent reads, queued title reads, forced foreground refresh, initial foreground load, then background refresh. Priority never preempts an active request; explicit cancellation does.
- Keep the existing 130-second scan and 15-second title deadlines. A timeout terminates and replaces the service because a timed-out parser cannot be assumed healthy.
- Cancellation rejects the caller immediately, sends `cancel`, and gives the service 2 seconds to acknowledge or finish. The service is terminated if it remains stuck.
- Continue returning the last good renderer result when a refresh fails.
- Invalidation is a control message, not queued scan work. The parent invalidates its result/host caches immediately and waits for the service acknowledgement before allowing a non-forced post-delete list result to reuse service cache state.
- Instrument serialized response size. Warn at 8 MiB. Do not reject legacy unlimited results until internal paging and public fallback are implemented.

The first implementation may reuse the current plain-object Node IPC serialization. The payload does not require handles, sockets, or transferable buffers.

## Lifecycle and supervision

### Startup

- Start lazily on the first scan or title request.
- Resolve an explicit entry path; packaged Electron must use `app.asar.unpacked` because `ELECTRON_RUN_AS_NODE=1` bypasses Electron's asar loader.
- Fork with `stdio: ['ignore', 'ignore', 'pipe', 'ipc']`, `ELECTRON_RUN_AS_NODE=1`, and `windowsHide: true` on Windows.
- Require a `ready` message within 5 seconds. A request does not enter its operation timeout until the service is ready.
- Pipe a bounded stderr tail into the existing diagnostic log. Never allow child output backpressure to stall the child.

### Steady state

- Reuse the process and caches across calls.
- Keep current parse concurrency at eight for the first A/B. Process isolation is not permission to increase concurrency.
- Set best-effort below-normal priority with `os.setPriority(child.pid, PRIORITY_BELOW_NORMAL)`. Failure to lower priority is observable but not fatal.
- Start with `--max-old-space-size=384`. Treat an out-of-memory exit as a service failure; keep terminals and the last Vault snapshot alive.
- Exit after 10 minutes with no active or queued request. Persisted parse-cache state makes a later cold process cheaper.

### Faults and restart

- Reject the active request on exit, disconnect, malformed protocol, or timeout.
- Retry queued work in a new process only when it is safe and has not been cancelled.
- Back off at 250 ms, 1 second, then 5 seconds.
- Open a 60-second circuit breaker after three unexpected exits in 60 seconds. Manual refresh may make one explicit restart attempt.
- On idle or orderly app/runtime/relay shutdown, flush any debounced parse-cache persistence, send the final acknowledgement, and exit. The parent waits at most 2 seconds, then terminates. Never hold host shutdown indefinitely.

## Resource and quality-of-service policy

The process boundary supplies crash and heap isolation. Priority and bounds supply responsiveness.

- CPU: below-normal process priority, scan concurrency eight, one scan at a time.
- Memory: 384 MiB V8 old-space starting cap, 4,096 title-cache entries, current parse-cache eviction, and response-size telemetry.
- Queue: 16 calls, coalescing, background replacement, explicit priority.
- I/O: stream transcripts; do not read an entire store into memory. Preserve current per-file streaming behavior.
- UI: defer result publication until terminal input has been quiet for 100 ms, with a 1-second maximum deferral so the panel cannot starve.
- React: publish inside `startTransition`; keep the previous snapshot visible while the transition is pending.
- Unlimited history: retain behavior during migration. Add internal pages before enforcing a hard serialized-result cap.

Process priority is best effort and cross-platform. Correctness must not depend on a particular scheduler implementation.

## Renderer publication

`ai-vault-session-refresh.ts` should stop applying a completed result immediately.

Add `ai-vault-session-publication-gate.ts` with this behavior:

1. Cache the validated result immediately so another caller can reuse it.
2. If no terminal has received input in the last 100 ms, publish now inside `startTransition`.
3. Otherwise retain only the newest pending result and wait for quiet.
4. Publish after 1 second even if input continues, using a transition and one bounded page.
5. Cancel a pending publication when the scope, host, or component request token changes.

Reuse the existing terminal-input quiet signal used by AI Vault tab-title synchronization rather than adding global key listeners per panel.

A separate Vault renderer remains a contingency only if post-service measurements show repeated renderer tasks over 50 ms that cannot be removed with publication scheduling, paging, and list virtualization.

## Desktop and runtime implementation

Create these concrete modules:

- `src/main/ai-vault/session-scanner-service-entry.ts`: process entry, init/ready handshake, request dispatch, cancellation, cache initialization, and shutdown.
- `src/main/ai-vault/session-scanner-service-client.ts`: queue, deadlines, cancellation, validation, and restart policy.
- `src/main/ai-vault/session-scanner-service-spawn.ts`: lazy shared client and public scan/title functions.
- `src/main/ai-vault/session-scanner-service-entry-path.ts`: dev, E2E, and packaged path resolution.
- `src/main/ai-vault/session-scanner-service-protocol.ts`: message types, schemas, and error codes.
- `src/main/ai-vault/session-scanner-service-priority.ts`: best-effort process priority policy.

Reuse the scanner and cache modules without moving their business logic. Replace imports in:

- `src/main/ai-vault/cached-session-list.ts`
- `src/main/ai-vault/session-title-resolver.ts`
- `src/main/ipc/ai-vault-subagent-list.ts`
- `src/main/ai-vault/session-first-user-prompt-read.ts`
- `src/main/ipc/ai-vault-delete.ts` for acknowledged service-cache invalidation after a successful delete
- `src/main/ipc/ai-vault.ts`
- `src/main/runtime/rpc/methods/ai-vault.ts`

Promote the parse-cache flush currently exposed only for tests into an internal production shutdown function. Idle and orderly service exits must await it within the shutdown grace period.

Keep the current worker implementation behind the rollout switch until the new process passes packaging and fault-injection coverage. Remove it in a later cleanup change, not in the initial migration.

## SSH relay sidecar implementation

Create:

- `src/relay/ai-vault-service-entry.ts`: bundled Node sidecar entry using the remote scanner and title reader.
- `src/relay/ai-vault-service-client.ts`: relay-owned supervisor and internal protocol adapter.
- `src/relay/ai-vault-service-priority.ts`: the same best-effort QoS policy without Electron imports.

Change `src/relay/ai-vault-handler.ts` so it validates public params and forwards them to the sidecar. It must no longer import or call `scanRemoteAiVaultSessions` or `readAiVaultSessionTitlesFromFiles` in the relay process.

`relay.ts` creates the client once, injects it into `AiVaultHandler`, and shuts it down with relay lifecycle. The PTY handler does not depend on sidecar readiness.

If the sidecar cannot start or crashes:

- Return a normal `AiVaultListResult` containing a host issue and no new sessions.
- Do not scan inline in the relay.
- Keep all PTYs, reconnect state, and other relay methods available.
- Allow the next manual refresh to cross the restart circuit breaker once.

Build `relay-ai-vault-service.js` for every current relay platform in `config/scripts/build-relay.mjs`. Include its bytes in the immutable relay content hash so a sidecar-only change deploys a new relay directory. The bundle must target Node 18 and rely only on Node built-ins plus already supported optional externals.

## Remote compatibility

The first implementation adds no public method, stream opcode, required field, or changed result meaning.

- Current desktop with new relay: calls the existing Vault relay methods; the new relay handles them through its sidecar.
- New desktop with current relay: calls the same methods and receives the same result shape.
- New desktop with an older relay lacking the method: uses the existing budgeted SSH filesystem fallback.
- Old desktop with new relay: unknown internal sidecar details never cross the wire.

Do not make a new client depend on internal paging fields from an older host. If public paging is added later, use optional request/result fields and fall back to the existing complete-result call when the host does not return paging capability.

The old-relay fallback is the explicit isolation exception. Keep its total budget and cancellation. Do not broaden when it is selected. Once relay adoption data shows the fallback is rare, it can be reduced or removed in a separate compatibility decision.

## Folder workspaces, WSL, and paths

- Scope paths remain opaque filesystem paths. Do not require a `.git` directory or worktree metadata.
- Continue using `path.join` and the existing host-platform path adapters.
- Keep Windows batch and shell selection unrelated to terminal-shell preference.
- Preserve WSL host identity and cache scoping; capability and cache state must not leak between distros or native Windows.
- An SSH service reads only the remote host's paths. A desktop service must not interpret remote paths as local paths.
- Title requests must continue through the existing readable-path resolution and allowed-root validation before opening a transcript.
- Subagent and first-prompt requests remain local-only and must validate renderer-provided paths against the same agent-source roots used for discovery, including managed and WSL roots. Tightening path validation must ship with parity fixtures so legitimate current roots are not rejected.

## Security boundary

The service is a performance and reliability boundary, not a privilege boundary.

- It has the same OS user and must access the same agent stores.
- Do not expose its IPC channel to renderer code or the network.
- The parent passes validated options; the service validates again before filesystem access.
- Do not log prompts, titles, transcript paths, environment values, or raw service messages.
- Preserve symlink and allowed-root checks for title reads.
- Inherit only the environment needed for current agent-home discovery and process operation. Document any removed variables with cross-platform tests before tightening further.

## Packaging

Desktop packaging changes:

- Add `session-scanner-service-entry` to the main inputs in `electron.vite.config.ts`.
- Add `out/main/session-scanner-service-entry.js` to `asarUnpack` in `config/electron-builder.config.cjs`.
- Reuse the existing unpacked entry-path pattern used by other forked processes.
- Add a packaged smoke test that resolves the real unpacked path, starts the service, scans one fixture, and shuts down.

Relay packaging changes:

- Bundle the sidecar beside `relay.js` and `relay-watcher.js` for every supported OS/architecture.
- Include it in `.version` content hashing and deploy completeness assertions.
- Verify reconnect and versioned-install cleanup keep the matching relay and sidecar together.
- No new native module is required, so the Linux glibc floor should remain unchanged. Continue running the packaging verifier.

## Observability

Add spans and counters for:

- Service start, ready latency, PID, restart reason, circuit-breaker state, and idle exit.
- Queue depth, queue wait, priority class, coalesced calls, and dropped background calls.
- Discovery duration, parse duration, candidates, bytes read, cache reuse, incremental parses, full parses, and result count.
- Parent/child serialization duration and serialized bytes.
- Child RSS and heap-used snapshots at request completion.
- Renderer result receipt, quiet-wait duration, transition publication duration, and displayed session count.
- Relay sidecar failures separately from PTY and relay-loop health.

Metrics must use counts, byte sizes, and durations only. Paths and transcript-derived content stay out of logs.

## Verification matrix

The design is not ready for default-on until each layer below passes with both the worker fallback and process backend where applicable.

| Layer               | Required coverage                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure parser         | Existing fixtures for every agent and format; incremental append, corrupt/partial input, title precedence, usage, previews, queued prompts, recoverable empties, and subagent counts                          |
| Backend equivalence | Worker versus process deep equality for complete list, title, subagent, and first-prompt results; only `scannedAt` and internal metrics may differ                                                            |
| Cache               | Cold/warm/incremental scans, persistence restart, atomic save failure, corrupt cache, app-version mismatch, delete generation guard, service invalidation acknowledgement, and idle-exit flush                |
| Queue/lifecycle     | Both logical lanes, priority, coalescing, 16-call bound, cancellation before/while queued/active, deadlines, malformed IPC, crash, OOM, backoff, circuit breaker, and shutdown                                |
| Desktop Electron    | Visible list, scope/host/depth controls, refresh/cancel, first-prompt copy, Claude/OMP expansion, delete, View/Open Log, live tail, resume, drag/drop, and service-crash terminal typing through Electron/CDP |
| Runtime/web         | List/title/resume parity, host restamping, managed Codex homes, unchanged no-op cancellation limitation, and unchanged unavailable subagent/first-prompt/delete behavior                                      |
| SSH relay           | All-agent remote list, title resolution, scope truncation, sidecar crash/timeout/OOM, PTY typing/output/reconnect continuity, old-relay fallback, and both mixed-version directions                           |
| Windows/WSL         | Native and per-distro roots, UNC paths, WSL deletion, priority failure fallback, hidden child windows, packaged entry path, and host-isolated cache/source state                                              |
| Linux/package       | Ubuntu 20.04/glibc floor, Node 18 relay bundle, packaged entry smoke, sidecar deploy/hash completeness, and no undeclared native dependency                                                                   |
| Folder workspace    | Workspace/project scope, ownership mapping, resume target, path actions, and deletion without assuming Git metadata                                                                                           |

The Electron feature-parity run must assert visible behavior rather than only inspecting the store. Service fault tests additionally assert PTY markers so a Vault failure cannot pass while silently disrupting terminals.

## Failure behavior

| Failure                            | User-visible Vault behavior                                                    | Terminal behavior                         |
| ---------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------- |
| Service fails to start             | Keep last result and show a retryable host issue                               | Unchanged                                 |
| Service crashes during scan        | Reject refresh, restart under backoff, keep last result                        | Unchanged                                 |
| Service exceeds memory cap         | Treat as crash and reduce confidence telemetry; do not remove the cap silently | Unchanged                                 |
| Scan or cancellation hangs         | Kill and replace service after the deadline/grace                              | Unchanged                                 |
| Queue is full                      | Coalesce or drop background work; foreground call gets a clear retryable error | Unchanged                                 |
| Relay sidecar unavailable          | Remote Vault host shows an issue                                               | Relay PTYs and reconnect remain available |
| Renderer publication is superseded | Drop the stale result and publish the newest scope only                        | Unchanged                                 |
| Old relay has no Vault method      | Use the existing bounded desktop fallback                                      | Existing compatibility limitation remains |

## Benchmark methodology

The new `bench:ai-vault-typing` command launches a fresh Electron app through Playwright's Electron/CDP path and uses an isolated home.

Each iteration:

1. Keeps the Vault panel mounted in both arms.
2. Seeds 300 new, newer-mtime Codex JSONL transcripts in the isolated home.
3. Alternates arm order to reduce warm-up bias.
4. Runs paced raw-mode terminal echo typing as the control.
5. Runs the same typing while programmatically starting a forced visible Vault refresh as treatment.
6. Verifies the newest seeded title is visible, proving the full scan and UI path completed.

The renderer records keydown-to-xterm-parse, keydown-to-xterm-render, long tasks, timer drift, animation-frame gaps, refresh duration, and missing echoes without polling or serializing the terminal buffer for each key.

Raw reports are written to the ignored `tests/tools/benchmarks/results/` directory.

## Current measurements

Machine: Apple M5 Pro, 64 GiB RAM, macOS 26.5.1. These are local-host measurements on the current worker-thread architecture after the recently merged performance work.

Pre-implementation parity baseline:

- 90 Vault-focused unit/integration test files passed: 778 tests covering parsers, caches, routing, deletion, resume, renderer projection, subagents, first prompts, and runtime contracts.
- Electron/CDP parity spot-check passed for long View Log tail stability, single-file session deletion, and Claude companion-directory deletion: 3 tests.
- The representative, stress, and final benchmark smoke runs all completed with visible Vault results and zero missing terminal echoes.

### Representative pass

Configuration: 3 iterations, 300 new sessions per iteration, 128 KiB assistant payload per session, 100 keys per arm at 30 ms cadence, 118.4 MB total seeded data.

| Metric                         |              Control |      Refresh active |
| ------------------------------ | -------------------: | ------------------: |
| Parse p50 / p95 / max          |  1.3 / 2.5 / 29.8 ms |  1.3 / 2.0 / 5.4 ms |
| Render p50 / p95 / max         | 5.9 / 10.0 / 35.4 ms | 5.8 / 9.5 / 10.6 ms |
| Worst timer drift              |              14.2 ms |             24.5 ms |
| Worst frame gap                |               9.4 ms |             24.9 ms |
| Renderer long tasks over 50 ms |                    0 |                   0 |
| Missing echoes                 |              0 / 300 |             0 / 300 |
| Refresh duration p50 / max     |                    — |    103.5 / 204.2 ms |

There is no treatment-side typing regression in this pass. The current worker is doing useful work and should remain the rollback path during migration.

### Stress pass

Configuration: 2 iterations, 300 new sessions per iteration, 512 KiB assistant payload per session, 120 keys per arm at 30 ms cadence, 314.9 MB total seeded data.

| Metric                         |             Control |       Refresh active |
| ------------------------------ | ------------------: | -------------------: |
| Parse p50 / p95 / max          | 1.3 / 1.9 / 19.7 ms |  1.4 / 4.7 / 13.8 ms |
| Render p50 / p95 / max         | 5.6 / 9.4 / 23.8 ms | 6.0 / 11.2 / 16.3 ms |
| Worst timer drift              |              9.3 ms |              43.6 ms |
| Worst frame gap                |              9.4 ms |              50.0 ms |
| Renderer long tasks over 50 ms |                   0 |                    0 |
| Missing echoes                 |             0 / 240 |              0 / 240 |
| Refresh duration p50 / max     |                   — |     276.3 / 453.5 ms |

The exaggerated workload causes measurable but bounded whole-system contention. It does not show renderer result application becoming a long task. This is evidence for a lower-priority service process and against a second Chromium renderer.

### Measurement limits

- One high-end macOS machine does not establish Windows, Linux, low-core, battery, or memory-pressure behavior.
- The benchmark covers the local service path, not the currently unisolated SSH relay path.
- Raw shell echo is a stable latency probe, not a full-screen TUI workload.
- A child process still competes for machine-wide CPU; the expected benefit comes from priority, heap/failure isolation, and supervision, not from eliminating CPU cost.

## Post-implementation A/B

Run the same build with the rollout switch off and on, alternating launch order:

```bash
ORCA_AI_VAULT_SERVICE_PROCESS=0 pnpm bench:ai-vault-typing -- --label worker-control
ORCA_AI_VAULT_SERVICE_PROCESS=1 pnpm bench:ai-vault-typing -- --label process-treatment
```

Run at least five representative and five stress passes on:

- macOS Apple Silicon.
- Windows x64 with a folder workspace and a WSL-backed source present.
- Ubuntu 20.04-compatible x64 packaging/runtime.
- A 4-core or smaller machine or constrained CI runner.

Add a Docker SSH variant that runs the same terminal probe while the remote sidecar scans. A fault arm kills the sidecar during typing and verifies the PTY marker stream and reconnect remain healthy.

## Implemented result

The implementation now matches the target topology:

- Desktop and runtime list scans, title resolution, subagent reads, and first-prompt reads use a lazy supervised child process by default outside unit tests. `ORCA_AI_VAULT_SERVICE_PROCESS=0` retains the worker fallback.
- Successful local deletion remains in the trusted main process and acknowledges child parse-cache invalidation. In-flight parses cannot restore an invalidated entry.
- The SSH relay handler no longer imports the remote scanner, transcript title reader, or filesystem provider. It forwards existing public methods to `relay-ai-vault-service.js`; sidecar failure returns a normal host issue.
- All six relay platform bundles include the sidecar, hash its bytes into `.version`, and require it in remote-install completeness probes.
- Renderer results cache immediately, retain only the newest pending publication, wait for 100 ms of input quiet, publish in a React transition, and cannot defer beyond one second.
- Desktop and relay supervisors bound the queue at 16, cap old-space at 384 MiB, use below-normal priority where supported, enforce ready/operation/cancellation/shutdown deadlines, and restart with bounded backoff plus a three-fault circuit breaker.

Local validation on 2026-08-09:

- Electron E2E build emitted `out/main/session-scanner-service-entry.js`; every relay target built `relay-ai-vault-service.js` successfully.
- Real built-child smoke checks passed for the desktop service title lane and relay sidecar list lane.
- Vault, runtime, renderer, relay, and remote-install focused tests passed 900/901 in one loaded run. The single unrelated 150 ms map micro-benchmark measured 184 ms during that parallel run and passed at 30 ms alone.
- Electron/CDP feature checks passed for long View Log stability, single-file deletion, and Claude companion-directory deletion with the process backend enabled.

Representative A/B configuration: 3 iterations, 300 sessions per iteration, 128 KiB payloads, and 100 keys at 30 ms cadence.

| Metric                | Worker control | Worker refresh | Process control | Process refresh |
| --------------------- | -------------: | -------------: | --------------: | --------------: |
| Parse p95             |         2.0 ms |         1.9 ms |          6.2 ms |          6.4 ms |
| Render p95            |         9.6 ms |         9.6 ms |         11.0 ms |         12.3 ms |
| Worst timer drift     |         9.4 ms |        17.4 ms |         10.4 ms |         12.0 ms |
| Worst frame gap       |         9.4 ms |         9.4 ms |         16.8 ms |         16.2 ms |
| Long tasks over 50 ms |              0 |              0 |               0 |               0 |
| Missing echoes        |        0 / 300 |        0 / 300 |         0 / 300 |         0 / 300 |
| Refresh p50 / max     |              — | 74.9 / 76.9 ms |               — | 83.2 / 165.1 ms |

The process arm stayed well inside every acceptance budget. It did not outperform the already-optimized worker on raw parse latency; its value is the intended heap, crash, priority, relay-loop, and lifecycle isolation while preserving terminal responsiveness.

Windows/WSL, Ubuntu 20.04, constrained-core, packaged-app launch, and Docker SSH fault measurements remain release/CI matrix work because they cannot be truthfully produced on this macOS host. The implementation includes their path, platform, packaging, Node 18, and mixed-version compatibility requirements; default rollback remains one environment variable.

## Acceptance criteria

Correctness:

- Zero missing terminal echoes.
- The latest seeded Vault session is visibly published in every treatment arm.
- Local, runtime, SSH, WSL, and folder-workspace session fixtures remain equivalent to the current scanner.
- Cancellation, force-preemption, host merging, title resolution, and unlimited history preserve current semantics.

Performance:

- Treatment parse p95 is no more than 10 ms above its paired control.
- Treatment render p95 is no more than 15 ms above its paired control.
- Median active-key render latency remains at or below 75 ms; worst remains below 300 ms.
- No renderer task attributable to Vault result publication exceeds 50 ms in the representative run.
- No relay PTY input/output stall exceeds the terminal reliability budget while its sidecar scans or crashes.

Isolation:

- Killing or exhausting the desktop service does not crash Electron main, runtime RPC, renderer, or terminal daemon.
- Killing or exhausting the relay sidecar does not interrupt PTYs, relay reconnect, or non-Vault methods.
- The service respects queue, timeout, idle, and heap bounds.
- Packaged app and relay artifacts contain and launch the correct entry for every supported platform.

## Phased implementation plan

### Phase 0 — measurement harness (completed in this change)

- Add `terminal-ai-vault-typing-latency.spec.ts` and its focused corpus/renderer probes.
- Add `run-ai-vault-typing-bench.mjs` and `pnpm bench:ai-vault-typing`.
- Capture representative and stress baselines.

Exit: reproducible JSON report, visible Vault completion assertion, zero missing echoes.

### Phase 1 — desktop and runtime service behind a switch

- Add the private service protocol, entry-path resolver, process entry, client, priority policy, and supervisor.
- Reuse current scanner/cache implementations.
- Route desktop IPC and runtime RPC through the service when `ORCA_AI_VAULT_SERVICE_PROCESS` is enabled.
- Keep the worker path as the disabled-switch fallback.
- Add unit tests for ready timeout, queue priority, coalescing, cancellation, operation timeout, crash, restart backoff, circuit breaker, idle exit, malformed messages, and packaged path resolution.
- Add E2E fault injection that kills the service during active terminal typing.

Exit: desktop/runtime correctness parity, packaging smoke test, representative/stress A/B within budgets.

### Phase 2 — make the desktop/runtime process the default

- Enable the process by default in development, E2E, and canary builds.
- Collect process RSS, restart, timeout, and latency telemetry without content.
- Validate Windows, Linux, WSL, and constrained-runner results.
- Keep `ORCA_AI_VAULT_SERVICE_PROCESS=0` as a release kill switch for one stable cycle.

Exit: no unexplained crash or timeout increase and all acceptance gates green.

### Phase 3 — SSH relay sidecar

- Add the relay sidecar entry and supervisor.
- Remove scanner/parser/cache imports from the relay handler.
- Add the sidecar to every relay bundle, content hash, deploy manifest, and completeness test.
- Add Docker SSH scan, typing, sidecar-crash, reconnect, old-relay fallback, and mixed-version tests.
- Make inline relay scanning impossible; sidecar failure returns a host issue.

Exit: remote typing and fault gates green; current public relay methods unchanged.

### Phase 4 — renderer quiet publication

- Add the shared quiet-publication gate and React transition.
- Retain only the newest pending result per scope/host.
- Add supersession, starvation timeout, unmount, and rapid-host-switch tests.
- Re-run the Electron benchmark with large result counts and active filtering/grouping.

Exit: no Vault-attributable renderer long task over 50 ms in the representative gate.

### Phase 5 — hardening and cleanup

- Remove the worker implementation after one stable release if the kill switch was unused.
- Decide whether public optional paging is necessary from serialized-size and renderer-publication telemetry.
- Promote `bench:ai-vault-typing` from an experimental benchmark to the terminal reliability gate.
- Document operational recovery and service diagnostics.

Exit: kill switch and dead worker code removed only after evidence supports it.

## Rollback

- Desktop/runtime: set `ORCA_AI_VAULT_SERVICE_PROCESS=0` to restore the current worker path without changing public APIs or stored data.
- Renderer: disable quiet publication and apply the validated complete result directly.
- Relay: deploy the prior immutable relay version. A new relay must never fall back to inline scanning when its sidecar fails.
- Parse-cache format remains unchanged during migration, so rollback does not require cache conversion.

## Confidence and remaining questions

Confidence in the overall topology is about 90%. Confidence that a separate Vault renderer is unnecessary is higher because both baseline passes recorded zero renderer long tasks. Confidence that the local child process alone will materially improve normal typing latency is lower: the current worker already performs well, and the process migration is primarily buying priority, heap, crash, and lifecycle isolation.

The remaining implementation questions are deliberately narrow:

1. Is 384 MiB the right old-space cap on Windows/Linux and for unlimited histories? Resolve with packaged stress runs before default-on.
2. Does the 10-minute idle exit improve retained memory without creating noticeable cold-refresh churn? Resolve with startup/RSS telemetry.
3. Is public paging necessary? Add it only if response-size or renderer-publication evidence crosses the stated budgets.
4. How large is the current SSH relay impact on low-core hosts? Resolve with the Phase 3 Docker and constrained-runner typing gate; it does not change the decision to remove scans from the relay loop.
