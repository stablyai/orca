# CDP outbound retention reproduction

From the worktree root:

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/cdp-stream-retention/reproduce.mjs
```

This bundles the current response writer and connects real loopback WebSockets. The reader pauses while the producer sends at most 128 MiB. The script starts no Electron application or PTY and closes all sockets. `before.json` records the same experiment against the unbounded writer; `after.json` records the fixed writer.

Before the fix, 128 MiB of generated payload left 133,177,280 bytes in the WebSocket buffer, with roughly linear growth at every sample. The fixed writer uses the existing outbound queue: an 8 MiB socket soft threshold, 64 MiB held-queue cap and 4,096 queued-frame cap. The stalled connection terminates on overflow and releases its queue. The socket threshold can overshoot by one frame; a single large reply on a clear connection remains permitted, preserving large PDF/screenshot responses. This bounds accumulated backlog, not the allocation needed to construct an individual response or the aggregate across arbitrarily many browser pages.

Unit tests also cover a reader that drains a complete burst in order, request/session correlation, queue disposal on close/replacement, and a 65 MiB healthy reply. Debugger events and command responses share this writer.

This establishes an Electron-main retention mechanism when a CDP automation client stops reading. Neither #19831 nor #19768 establishes that precondition, so it is not a confirmed cause of either incident. RSS reflects GC/allocator timing; queued bytes are the direct measurement.
