# Remote runtime snapshot bandwidth

Issue #22151 reports a remote connection whose subscription traffic starves file
operations. The reporter's deployment has **not** been independently reproduced.
This change targets `session.tabs.subscribe` and `session.tabs.subscribeAll`, not
all runtime traffic or terminal scrollback recovery.

## Why WebSocket compression alone does not solve it

Desktop subscriptions pass through `E2EEChannel`: JSON is encrypted and base64
encoded before `ws.send`. Enabling `permessage-deflate` on that ciphertext could
remove some base64 expansion, but cannot compress repeated JSON metadata. The
WebSocket server therefore retains its existing compression policy.

The authenticated client instead advertises `remote-runtime.snapshot-deflate.v1`.
For runtime-scoped snapshot subscriptions only, the server keeps the usual RPC
envelope and replaces `result` with `null`, adding `compressedResult` containing:

- `encoding: "deflate-raw"`, compressed structural JSON in base64 `data`, and its
  uncompressed byte count `bytes`;
- an **uncompressed** `literals` array and the reconstructed result's `resultBytes`.

The existing E2EE channel encrypts the entire envelope. After authenticated
decryption, the subscription frame router restores the result before the normal
RPC envelope validator and response-ID routing. There is no new stream opcode,
terminal format, encryption primitive, state delta, or delivery-order change.

## Confidentiality and bounds

A VPN does not prevent compression length oracles. A fresh dictionary alone also
does not prevent a chosen title from matching a secret prompt in the same frame.
Consequently, only fixed schema keys, enumerated states, numeric metadata, and
validated UUID-shaped routing identifiers enter deflate. Titles, paths, URLs,
drafts, prompts, assistant messages, unknown values **and unknown field names**
remain in the uncompressed literal array. No deduplication or substring matching
is performed on literals. Routing identifiers are not bearer credentials;
nonconforming legacy identifiers go through the literal path too.

Tests compare equal-length secrets and matching/nonmatching attacker text: the
compressed structural bytes and total encoded lengths must be identical. Unknown
fields and prototype-looking keys roundtrip exactly. Ordinary message length,
field presence, and public structural-state changes remain observable, as they
already are without padding; this is not a traffic-analysis-resistant protocol.

Compression uses a new level-1 deflate context, 32 KiB window and `memLevel: 5` per
message. Execution is synchronous, so there is no unbounded compression job queue
or concurrent pool. Original results and structural input are each capped at
256 KiB; results below 1 KiB, oversized results, excessive literal counts, JSON
depth expansion, or results that would grow keep the original envelope. Existing
E2EE process/socket/queue admission remains authoritative.

The receiver checks negotiation, envelope ambiguity, encoding, canonical base64,
declared size, bounded actual inflate output, literal references/count/bytes,
restored result size, and the existing JSON structural limits. Repeated literal
references cannot multiply retained data. Malformed compressed frames produce
`invalid_runtime_response` and close the subscription, without a silent fallback.

## Reproducible evidence

Run from the worktree with installed dependencies:

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm exec vitest run --config config/vitest.config.ts \
  src/main/runtime/rpc/runtime-bandwidth.test.ts \
  src/shared/remote-runtime-snapshot-compression-cost.test.ts \
  --maxWorkers 1 --disableConsoleIntercept
```

The fixture uses typed session-tabs results with distinct deterministic UUIDs,
titles, paths, agent status and prompts, rather than one repeated filler string.
Both variants run the real E2EE channel and outbound queue. Every snapshot and
every terminal frame is decrypted and compared byte-for-byte or field-for-field.
Separate localhost integration tests run the actual WebSocket transport and
subscription client, including encrypted handshake, mixed capabilities, opt-out,
malformed data, file-list RPC, connection drop, and resubscription.

The network part is explicitly a **deterministic FIFO serialization model**, not
observed WAN latency: 100,000 bytes/s (0.8 Mbps), 37 ms propagation each way, no
packet loss, TCP/IP/VPN overhead, kernel buffering, retransmission, or application
execution delay. It accounts for actual encrypted payload lengths plus server
WebSocket frame headers. Each 34-second cycle has 30 seconds of snapshots every
500 ms, followed by a four-second burst every 100 ms; three cycles test that
backlog does not accumulate. Terminal payload is 2,100 bytes/s, and small
`files.list` / `files.read` responses share the same FIFO twice per second.

Measured on macOS arm64, Node 24.18.0 (102 seconds of modeled traffic):

| Terminals | Legacy wire bytes | Structural compression | Reduction | Modeled RPC p95 before / after | Modeled RPC max before / after | Peak modeled queued bytes before / after |
| --------- | ----------------: | ---------------------: | --------: | -----------------------------: | -----------------------------: | ---------------------------------------: |
| 15        |         5,477,142 |              2,834,694 |     48.2% |                 2,467 / 116 ms |                 3,221 / 116 ms |                          319,194 / 8,714 |
| 17        |         6,134,830 |              3,117,958 |     49.2% |                 3,247 / 125 ms |                 4,120 / 125 ms |                          409,066 / 9,659 |
| 20        |         7,122,342 |              3,548,218 |     50.2% |                 4,696 / 418 ms |                 5,469 / 585 ms |                         544,038 / 55,626 |

The 17-terminal legacy fixture averages 60.1 KB/s. These rates reproduce the
reported traffic _scale_, not the reporter's exact workload or stream attribution.
The regression targets are at least **40% fewer bytes**, at least **80% lower modeled
p95**, max below **1 second**, and peak modeled backlog below **128 KiB** across 15–20
terminals. The initial 70% reduction proposal was deliberately relaxed to avoid
compressing sensitive text. No snapshots or terminal bytes are discarded.

Node 26.9.0 produces larger compressed frames for the same fixtures. Its 15/17/20
terminal runs measured 2,918,770 / 3,217,538 / 3,672,210 wire bytes, p95 of
119 / 131 / 525 ms, maxima of 119 / 133 / 754 ms, and peak backlogs of
8,990 / 10,514 / 72,534 bytes. Thus the earlier 500 ms p95 / 64 KiB targets were
specific to the Node 24 compressor. The portable gate instead retains a subsecond
maximum, a large relative latency improvement and a bounded queue, without
requiring identical compressed output across runtime versions. This changes the
benchmark acceptance criteria, not the compression implementation.

A separate 500-message encoder run with 17,000-byte, 20-terminal snapshots used
231 ms of process CPU (about 0.46 ms/message), with 8.9 MB peak sampled JS heap
growth, 87 KB retained heap growth after GC, and 19.9 MB RSS growth. Wall p95 was
1.29 ms and max 11.27 ms on a shared development host. These are diagnostic
measurements, not portable limits or latency guarantees; RSS includes native
allocator retention. The codec adds bounded allocation and CPU in exchange for
less encryption work and fewer transmitted bytes, and keeps no peer dictionaries.

## Compatibility, limitations, rollback

- Old clients do not advertise the capability and receive the original JSON.
  New clients continue accepting legacy replies from old hosts.
- `snapshotCompression: false` removes the capability even if it was supplied in
  additional client capabilities. Compression is not advertised by one-shot RPC
  clients or required from a host. Mobile and relay framing are unchanged.
- The implementation uses Node's built-in zlib and no OS-specific paths, shell
  commands, native additions, Git assumptions, or local execution fallback.
  Local tests ran on macOS; Windows/Linux/SSH-host execution was not exercised.
- File contents, terminal bytes, large/free-text-heavy snapshots, replay bursts,
  unrelated subscriptions and incompressible traffic may still saturate a link.
  This change adds no priority scheduler and makes no universal latency promise.
- The reporter's inventory share is unknown. Confirmation on that deployment is
  still needed; do not infer complete resolution from this fixture.
- Roll back by removing capability advertisement or returning the original reply
  from the host wrapper. There is no persisted format or state migration, and a
  reconnect requires no shared dictionary. Keep decoder support during a staged
  rollout rollback if any hosts may still use the negotiated capability.

No application windows or running user runtime were touched. Rendered Electron
verification was not performed (the required electron skill is unavailable);
these are transport tests, not visual UI evidence.
