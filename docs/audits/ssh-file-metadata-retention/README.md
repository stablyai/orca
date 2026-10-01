# SSH file readers retain unrelated streams before metadata

The file reader queued every file-stream notification while awaiting its own metadata. A delayed read therefore retained payloads from other reads that had already completed. The fix installs metadata through the mux's existing synchronous `beforeResolve` callback and ignores notifications until the read has a stream identity. Listeners still register before the request, and own frames adjacent to the response are processed correctly.

This is conditional transient retention during a pending metadata request. The proof establishes a source mechanism and its correction; it does not identify an affected host, measure a natural native I/O stall, or attribute #19831 to SSH.

## Actual producer and ownership chain

1. Desktop `filesystem-read-handlers.ts` calls the selected `SshFilesystemProvider.readFile` for `fs:readFile`; this route does not serialize reads. Runtime previews also use the provider with caller-specific caps. An AI-vault scan has an eight-operation gate, which still permits repeated completions in other slots while one operation waits.
2. `readFileViaStream` subscribes to chunk/end/error notifications before sending `fs.readFileStream`. Previously it appended all such notifications until the metadata promise's `.then` callback ran, even when they belonged to other streams.
3. Relay `FilesystemHandler` forwards the path and request context to `readRelayFileStreamMetadata`. The producer awaits `stat` before acquiring a stream slot. For unknown MIME types, its prefix probe also precedes registration. After opening/registering the file, it schedules its pump with `setImmediate` and returns metadata.
4. `RelayDispatcher` publishes the small metadata response in its control lane; the writer prioritizes control before bulk. The saturated-writer control verifies metadata precedes chunks after drain.
5. The mux runs `beforeResolve` synchronously during response dispatch, before resolving the request promise. Its decoder can dispatch adjacent notifications before any `.then` callback runs. The fix installs the stream ID and buffer at that synchronous boundary, eliminating the need to save foreign frames.

The producer, mux, dispatcher, decoder, writer, file I/O, and stream registry are actual source in the portable proof. The fixture connects both ends through an in-memory duplex transport, uses real temporary files, and supplies the filesystem handler's small path/client/pacing adapter. It does not launch an SSH process, Electron window, native PTY, or network server.

## Bounds and payload sharing

- The relay allows **16 concurrent registered streams**, with a **four-chunk ACK window** per paced stream. Chunks are 256 KiB. A metadata operation waiting before registration occupies no stream slot. Other transfers can complete and reuse slots repeatedly.
- Reader size caps are **10 MiB text / 50 MiB binary**, optionally tightened by the caller. They apply after that reader's metadata and do not charge foreign history accumulated before it.
- The metadata request has a **30,000 ms deadline**. After metadata, the reader uses a **60,000 ms inactivity deadline**, reset by its own chunks and integrated with suspend/resume. Connection disposal also releases subscriptions. These timers and transport throughput bound ordinary retention duration; suspension/event-loop stalls can delay timers. No indefinite native stall was established.
- The decoder limits each turn to 64 frames / 4 ms and bounds retained framing bytes. Those limits do not bound arrays owned by subscribers after frames are parsed.
- The mux passes the **same parsed params object** to all subscribers. Four waiting readers add four wrappers per frame, but share its payload. The result is not four copied payloads or quadratic payload-byte growth.

## Comparative results

All **80 portable cases pass**: ten controls × baseline/fixed × audited-worktree/named-main graph × Node/Electron. Node is 26.6; Electron 43.7 uses Node 24.21. Reports record exact versions, all 59 selected source hashes, the observed reader hash, and proof artifact hashes.

| Observation                                                             |                            Before |    Fixed |
| ----------------------------------------------------------------------- | --------------------------------: | -------: |
| Four waiting readers; 16 completed 2 MiB transfers                      |                      576 wrappers |        0 |
| Unique shared params objects retained                                   |                               144 |        0 |
| Logical base64 bytes, counted once per unique params object             |                        44,739,584 |        0 |
| Peak registered streams in that workload                                |                                 1 |        1 |
| ACKs processed                                                          |                               128 |      128 |
| Reader history after metadata completion, handled disposal, or deadline |                          released | released |
| Actual pump with ACK delivery withheld                                  |              stops after 4 chunks |     same |
| Sixteen active streams, then a seventeenth request                      | refused; later admission succeeds |     same |
| Saturated writer, then drain                                            |        metadata before own chunks |     same |
| Response plus own chunk/end in one decoder turn                         |                    correct result |     same |
| Unpaced producer / ordinary completion                                  |                    correct result |     same |
| Canonical LF vs synthetic CRLF source/patch reads                       |                    66 reads agree |     same |

The primary portable workload deliberately gates four request handlers **immediately before invoking the actual relay file producer**. The request remains pending while other real transfers complete. This controlled adapter delay is distinct from a native `stat` already in progress; production source establishes that awaiting `stat` occurs at the same pre-registration phase. It does not measure how often or how long native metadata I/O delays occur on a user's machine.

The baseline observation adds only `WeakRef(pending)` to expose the closed-over array. It does not add a strong owner. Shared params identity is checked across all waiting readers. Heap deltas support the object/byte accounting but are neither exact object sizes nor RSS. After disposal, the test consumes lazy `Error.stack` and retains only error codes: externally retained unmaterialized V8 error stacks can themselves retain callback context, so the release claim is after normal error handling.

Every successful transfer checks payload length and SHA-256. Stream capacity, pacing, cancellation, and output assertions run identically for both variants. The controlled producer ignores ACK pacing in one case; this tests existing unpaced behavior, not every historical relay binary.

## Source graphs and publication

`source-versions.json` records the full 59-module import graph and five additional actual caller hashes. Both graphs select the same file-reader source variant. The audited worktree and named main `291b4ddd6f1c1af480169885e0fda7f9c78ff053` otherwise differ only in the previously published SSH writer consumed-prefix correction.

`main-context.patch` reconstructs that single context difference in memory. The loader accepts either of its two exact recorded checkout hashes and reconstructs the selected graph. This lets the same artifact run on this worktree or the independent main publication without depending on another memory PR. `fix.patch` is the separate, single-product-file change under review. Every other graph/caller source is hash-fenced; unknown production imports fail. Dedicated portable tests omit unrelated global Vitest setup files.

The current reader baseline and relay file producer are also byte-identical to `v1.4.198` (`e0826956fcfc532f5a1e55b5e081f2e57e553c43`). That named version has synchronous `beforeResolve` and control-first writer scheduling. Its comparison is limited to the recorded paths; the proof does not execute a whole historical application.

No wire field, opcode, host execution verdict, stream cap, timeout, fallback, or native process lifetime changes. Existing MethodNotFound fallback and malformed-metadata / tighter-cap / empty-image / adjacent-error handling are covered through the actual mux by the permanent regression suite.

## Reproduce

Choose either graph (`worktree` or `main`) and variant (`before` or `fixed`):

```sh
ORCA_BACKGROUND_LAUNCH=1 ORCA_SSH_READER_GRAPH=main ORCA_SSH_READER_VARIANT=fixed pnpm exec vitest run --config docs/audits/ssh-file-metadata-retention/vitest.config.mjs
```

For Electron, invoke the installed Electron binary with `ELECTRON_RUN_AS_NODE=1` and `ORCA_BACKGROUND_LAUNCH=1`, passing `node_modules/vitest/vitest.mjs` and the same arguments. Reports are separate for every graph/variant/runtime. Set `ORCA_SSH_READER_OUTPUT` to an alternative file path to preserve captured reports.

Permanent tests and the intentional baseline failure:

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm exec vitest run --config config/vitest.config.ts src/main/ssh/ssh-filesystem-stream-retention.test.ts src/main/providers/ssh-filesystem-provider-stream.test.ts src/main/providers/ssh-filesystem-provider.test.ts src/main/ssh/ssh-channel-multiplexer.test.ts src/relay/fs-handler-stream.test.ts
ORCA_BACKGROUND_LAUNCH=1 pnpm exec vitest run --config docs/audits/ssh-file-metadata-retention/before.config.mjs src/main/ssh/ssh-filesystem-stream-retention.test.ts src/main/providers/ssh-filesystem-provider-stream.test.ts
```

The baseline keeps all 64 observed foreign frame objects while metadata remains pending, causing exactly the new lifetime assertion to fail; the other 22 tests pass. The initial four-suite run passed 70 tests. Detailed quality/typecheck results are in `validation.json`. Full-file casting diagnostics are the same 15 inherited assertions in the original reader and provider test, verified by exact diagnostic/source-span comparison; the changed-code gate reports no new findings. No lint rule was suppressed and no unrelated wire validation behavior was changed to satisfy that baseline cleanup.

The expanded five-suite run passes **124 tests**, including the general provider suite. The empty-file control uses the existing streaming fixture, which invokes the mux's `beforeResolve` callback before resolving metadata, and verifies all stream listeners are released. The older generic fixture omitted that callback and reproduced the CI timeout; actual-mux empty metadata controls already passed. This correction changes test setup only.
