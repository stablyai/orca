# SSH Typing Latency Under Relay Load

Date: 2026-07-06

## Symptom

Typing in an SSH-host terminal can become extremely slow (hundreds of ms to
seconds per echoed keystroke) while other SSH work is active — file previews,
source-control refresh, search. A quiet SSH shell stays snappy, which made the
reports look unreproducible.

This is distinct from the local warm-switch lag documented in
`terminal-switch-typing-lag-investigation.md` (daemon `listSessions()`
snapshot cost — already fixed; `TerminalHost.listSessions()` is now
metadata-only via `getAppliedSize()`).

## Root Cause

The relay and the Electron client share ONE ordered SSH channel for all
JSON-RPC traffic: PTY input/output, file streams, git responses, search, port
scans. Two mechanisms turned bulk traffic into typing latency:

1. **Relay-side head-of-line blocking (primary).** The `fs.readFileStream`
   pump (`src/relay/fs-handler-file-read.ts`) wrote every 256KB chunk (~340KB
   framed) into the relay's stdout as fast as local disk reads completed,
   ignoring the `write() === false` backpressure signal. A 10MB preview
   enqueued ~13.6MB into the pipe at once; a `pty.data` echo emitted
   mid-stream queued behind ALL of it. At 2MB/s WAN that is multiple seconds
   of echo delay per open file. The reproduced measurement: 4,195,592 bytes
   (the entire remaining 3MB test file, framed) queued ahead of one echo
   frame.

2. **Client-side O(n²) frame buffering (secondary).** `FrameDecoder.feed()`
   in both `src/main/ssh/relay-protocol.ts` and `src/relay/protocol.ts` did
   `Buffer.concat([buffered, chunk])` per data event, re-copying the whole
   backlog for every ~32KB TCP chunk — ~2MB of memcpy per 340KB frame,
   ~80MB per 10MB file — on the Electron main thread, delaying `pty:write`
   IPC dispatch and echo delivery to the renderer.

## Fix

- **Bulk lane with sink backpressure** (`RelayDispatcher.notifyBulk`):
  `fs.streamChunk` frames are serialized per client and each send waits for
  the sink's `drain` when `write()` returns `false`. Interactive frames
  (`pty.data`) still use plain `notify()` and are admitted immediately —
  because the bulk lane keeps the outbound buffer at ~1 frame, an echo jumps
  ahead of every not-yet-admitted chunk. Sinks (`relay.ts` stdout + Unix
  socket clients) surface `write()`'s boolean and a one-shot
  `waitWriteDrain`; every death path (EPIPE, stdin end, detach, dispose)
  flushes parked waiters so a pump can never hang on a dead pipe.

- **Credit-based flow control** (`fs.streamAck`): the client requests
  streams with `flowControl: 'ack'` and acks each processed chunk; the relay
  caps unacked chunks at `STREAM_ACK_WINDOW_CHUNKS = 4` (~1MB raw). This
  bounds in-flight bulk bytes even past the relay's own pipe (sshd/TCP
  buffers) and paces the relay's base64/JSON encode loop so incoming
  keystroke frames get event-loop turns. A parked pump wakes on ack, cancel,
  release, client detach, and a 1s staleness recheck.

- **Cross-version compatibility**: old client + new relay → no
  `flowControl` param → legacy unpaced pump (still drain-bounded, which is
  transparent). New client + old relay → `fs.streamAck` is an unknown
  notification and is silently ignored. `STREAM_CHUNK_SIZE` (256KB) is
  intentionally unchanged — both sides bake it into chunk offset math, so
  changing it would corrupt cross-version streams.

- **FrameDecoder rewrite** (both mirrored protocol files): chunk-list
  buffering; each frame is assembled exactly once (one copy) instead of
  re-concatenating the backlog per feed.

## What Stays Fast / Unchanged

- Relay PTY output batching (interactive echo fast path in
  `src/relay/pty-handler.ts`) is untouched.
- No `listSessions()` / provider inventory was added anywhere near typing,
  focus, switch, resume, resize, or render paths.
- Remote file streaming correctness: per-chunk length checks, chunk-count and
  byte-count invariants, cancel paths, and the 12MB round-trip integration
  test all pass unchanged.

## Regression Coverage

- `src/relay/fs-stream-pty-echo-backpressure.integration.test.ts` — real
  mux ↔ dispatcher ↔ FsHandler over a congestible in-memory pipe; asserts
  deterministic BYTE bounds (not wall-clock): echo queues behind < 2 framed
  chunks when congested (pre-fix: whole file), ack window caps in-flight
  chunks, legacy no-ack clients still get complete streams.
- `src/relay/fs-handler-stream.test.ts` — pump parks at the ack window,
  resumes per ack, and releases its file handle when cancelled while parked.
- `src/relay/dispatcher.test.ts` — notifyBulk semantics: drain gating,
  per-client targeting, dispose releases parked senders, interactive
  notify() not gated behind a stalled bulk lane.
- `src/main/ssh/relay-protocol.test.ts` — decoder byte-at-a-time boundary
  straddling, oversized-frame resync across odd chunk sizes, and a
  no-`Buffer.concat`-during-feed guard that locks out the O(n²) shape.
- `tests/e2e/ssh-docker-relay-perf.spec.ts` — new "busy relay" scenario:
  types while two 8MB remote file-read loops and a git.status loop run;
  budgets median < 500ms, worst < 2000ms. (On loopback Docker the pre-fix
  HOL is only tens of ms — the in-process byte-bound test is the
  authoritative red/green; the e2e guards the end-to-end wiring.)

## Residual Gaps

- **Large single-frame responses**: `git.*` responses (stdout capped at
  `MAX_GIT_BUFFER` = 10MB → ~13MB framed) and other request/response results
  are one atomic frame on the wire; a huge diff can still delay an echo by
  its own transfer time. Fixing this requires response chunking (a protocol
  change); bounded by the 16MB `MAX_MESSAGE_SIZE`.
- **Outbound direction**: a large `fs.writeFile` request frame (client →
  relay) can queue ahead of keystroke `pty.data` frames on `channel.stdin`.
  Same shape, opposite direction, rarer trigger (saving a large remote file
  while typing).
- `pty.ackData` flow control for PTY output remains unenforced
  (`src/relay/pty-handler.ts` — "not yet enforced"); PTY output floods are
  already paced by the relay's 8ms batch/16KB slice scheduler.
