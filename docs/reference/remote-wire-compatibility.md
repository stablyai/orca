# Remote wire compatibility

Orca's remote-server feature pairs a desktop client to a remote Orca runtime, and
users update the two independently. **Mixed versions are the normal state**, not an
edge case. This page is the contract for changing anything a paired client and host
exchange: the runtime RPC envelope, the terminal binary stream, and the content
either side publishes over them.

`src/shared/protocol-version.ts` says when to bump `RUNTIME_PROTOCOL_VERSION`. This
page covers the changes that do _not_ bump it and are therefore easy to get wrong.

## Rule 1 — a new optional JSON field on an existing frame is safe

Every JSON payload is parsed with a decoder that ignores unknown keys (zod `.strip()`
on RPC params, `JSON.parse` on stream frames). An older peer that has never heard of
the field simply does not read it.

Safe:

```ts
// host adds a field; older clients ignore it
encodeTerminalStreamJson({ kind, cols, rows, hiddenOutputReason })
```

**The field is safe only for as long as every reader treats it as optional.** The
moment a newer client _requires_ it, that client is broken against every host that
predates the field — which is the same defect as removing a field, just discovered
later. If new behavior depends on the field being present, that is Rule 2: negotiate
it, or make the reader fall back.

## Rule 2 — a new stream opcode is NOT safe; negotiate it

`decodeTerminalStreamFrame` returns `null` for an opcode it does not know, and
`runtime-rpc.ts` drops that frame without an error:

```ts
const frame = decodeTerminalStreamFrame(bytes)
if (!frame) {
  return // silently dropped — the sender never learns
}
```

So a new opcode sent to an older peer does not fail loudly. It vanishes, and the
feature behind it appears to hang. Input sent under a new opcode is swallowed.

A new opcode must be announced in the subscribe handshake and sent only after the
peer confirms it. The existing pattern is `SetOutputPaused` (opcode 16):

- the client advertises support in the `Subscribe` frame's `capabilities`;
- the host echoes `capabilities: { outputPause: 1 }` on the `subscribed` event;
- the client sends opcode 16 only after that echo (`stream.supportsOutputPause`);
- the host only acts on opcode 16 when it negotiated it (`stream.supportsOutputPause`).

Reuse an existing opcode with a new optional payload field (Rule 1) whenever that
expresses the change; reach for a new opcode only when framing genuinely differs.

Opcode numbers are permanent. See the `Ack = 13` and `ClaimViewport = 14` comments
in `src/shared/terminal-stream-protocol.ts` for why a shipped number cannot be
reused even if the feature behind it is removed.

## Rule 3 — changing what the host publishes breaks old clients with no wire change

The frame shape can be untouched and the skew still real, because clients react to
frame _content_. PR #12641 is the worked example: the host stopped synthesizing a
finished agent status, and clients running older code saw different content in an
identical frame.

Treat these as wire changes even though nothing in the codec moves:

- a field the host stops populating (an old client reading it now sees `undefined`);
- a value whose meaning, units, or nullability changes;
- content the host stops synthesizing, trims, or starts deriving from a new source;
- a frame the host stops sending, or starts sending, on an existing path.

If old clients cannot interpret the new projection correctly, gate it behind a
runtime capability the same way Rule 2 gates an opcode.

## Enforcement

`tests/e2e/cross-version-wire/cross-version-terminal-wire.unit.test.ts` runs the real
host RPC methods and the real renderer multiplexer from two builds against each
other — current working tree against the newest release tag, in both skew
directions — over one scripted terminal journey (subscribe, input, hide/reveal
snapshot, drop, reconnect).

Run it with:

```bash
pnpm exec vitest run --config config/vitest.config.ts tests/e2e/cross-version-wire/cross-version-terminal-wire.unit.test.ts
```

It fails when a frame is refused by the receiving build's decoder (Rule 2), when the
observed frame sequence changes (Rule 3), or when published snapshot content or
negotiated capabilities differ from the contract. Adding an optional field keeps it
green (Rule 1); making a client depend on that field turns the new-client/old-host
pairing red.

The harness covers the terminal stream only. It does **not** cover the session-tab
sync channel, agent-session publications, file or Git RPCs, mobile/E2EE framing, or
the relay transport. A change on those paths still needs its own reasoning against
the three rules above.

## Worked example: `agentWait` on terminal and worker reads

`terminal.show`, `orchestration.workerShow` and `orchestration.federationShow` carry an
optional `agentWait` naming a pane parked on a prompt only a human can answer. It is Rule 1 —
a new optional field — but it has a second state that Rule 1 alone does not describe, and
getting that wrong turns a skew into a false "nothing is blocked".

- **present object** — this pane is waiting, with the evidence that proved it.
- **present `null`** — the host evaluated this pane and nothing proves a wait.
- **absent** — the host never evaluated it: it predates the field, the worker identity was
  unverifiable, the pane was unreadable, or the agent probe did not answer in time.

A new client against an old host sees the field absent, which is why absence must read as
*unknown* and never as *not waiting*. Collapsing absent into `null` at any hop — including a
convenience `?? null` in an RPC handler — makes an old or unreachable peer indistinguishable
from a healthy idle worker, which is the exact failure the field exists to remove.

An old client against a new host ignores the key, as Rule 1 allows. New members added to
`RuntimeTerminalWaitBlockedReason` are also Rule 1: no consumer switches exhaustively on it,
and both the CLI and worker-start interpolate it as an opaque string.

## Known debt: JSON-RPC errors drop Node's string code

An error raised on an SSH host crosses the relay as JSON-RPC, and
`ssh-channel-multiplexer` rebuilds it with the TRANSPORT's numeric `code`. Node's
string code — `'ENOENT'`, `'EACCES'` — does not survive, so a caller on this side
cannot ask what kind of failure it was.

`isENOENT` in `src/main/ipc/filesystem-path-containment.ts` pays for that by also
matching Node's canonical message text, which is what makes remote worktree creation
work. The cost is that a host can make an unrelated failure read as "absent" by
putting that sentence in a message.

The exit is Rule 1: carry the original string code in a new optional field on the
error payload and read that instead. An old host omits it and the message match still
covers them; once hosts that send it are the floor, the message match can be deleted
rather than lived with at its ~10 call sites. Narrowing `isENOENT` back to `.code`
without doing this reinstates the bug — the transport has already overwritten it.
