# Terminal startup timing

For #19333, enable the renderer's opt-in recorder in its DevTools console before opening a new terminal:

```js
localStorage.setItem('orca:terminal-startup-timing', '1')
```

Remove the key to disable it. Existing sessions are unaffected. To capture the existing host spawn phases, start the host with `ORCA_PTY_SPAWN_TIMING=1`. Do not restart a host with active work just to enable diagnostics.

The renderer emits one `terminal_startup_timing` breadcrumb per transport callback generation through the existing local diagnostic channel. In `main.trace.ndjson`, find the `renderer.breadcrumb` record whose `breadcrumb.name` matches. The host's existing console timing line also becomes a `pty.spawn.timing` trace record. Correlate available PTY IDs; renderer generation distinguishes retries. Compare elapsed durations within each process, not wall clocks across hosts.

Renderer offsets are monotonic milliseconds from callback-generation creation immediately before a transport operation:

| Field | Observation |
|---|---|
| connected | Transport connection callback accepted for the current generation |
| liveData | First nonempty live delivery, including control-only output |
| submitted | First live batch sent to the renderer output scheduler |
| writeStarted | Scheduler invokes the batch's pre-write callback |
| parsed | Xterm invokes that batch's completion callback |
| renderEvent | First public xterm render event after the batch starts writing |

A render event can precede the parse callback. These observations do not establish the first printable glyph, physical screen presentation, React mount time or click-to-paint latency. Replay and synthetic reset writes do not claim the first live batch. A replay or resize can still contribute to a render event after a live write, so the event is temporal evidence rather than attribution to exact content. Hidden or restored panes may never submit a live batch; missing fields remain missing. A queue-cap warning can inherit the pre-write callback while discarding the original batch’s parse callback. In that case writeStarted/renderEvent describe incomplete pre-write activity, not successful delivery of the original batch; outcome cannot be observed without parsed.

The recorder ends after connection, parse and render observations, or on replacement, disposal, error or a ten-second diagnostic deadline. It retains only phase numbers and identifiers, with one timer and at most one render listener while enabled. It does not retain terminal text, commands, credentials or transcript buffers. Disabled recording adds no listeners or timers.

Host `phaseDurations` preserve the current phase boundaries: the timer starts after initial ownership lookups and logs before all commit/serializer work finishes. `totalMs` is that measured interval, not full IPC latency. `provider_spawn` includes provider call and surrounding reconciliation; it is not raw process creation time. The enclosing trace record is a diagnostic snapshot, not a span covering that interval.

Reliability invariant: diagnostics must not change terminal output, delivery credits, provider ownership or spawn outcome. Failure source: Windows OMP first-paint report #19333. Oracle: opt-in recorder tests distinguish queued, parsed and render milestones; existing live-delivery and synchronized-output suites preserve output behavior. No matching startup diagnostic reliability gate exists; full click-to-physical-presentation remains an explicit validation gap. Native, daemon, WSL and SSH execution remain host-owned; this adds no wire fields or remote process queries. Mobile has no recorder change. macOS/Linux/Windows renderer timing uses the same public xterm events; physical-device timing requires a separate capture.
