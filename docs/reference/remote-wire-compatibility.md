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
negotiated capabilities differ from the contract. Repeated frame shapes are compared
by corresponding journey occurrence (initial, reveal, reconnect), so a field removed
from one occurrence cannot hide behind a sibling that still publishes it. Adding an
optional field keeps the suite green (Rule 1); making a client depend on that field
turns the new-client/old-host pairing red.

### Never write down what the old side has

The baseline is whichever release tag is newest, so it moves on every cut. An
expectation of the form "the old side does not have X" — a `not.toHaveProperty`, a
`not.toContain`, a hard-coded field list — stops being true the first time a release
ships X. The suite then reddens on whatever pull request is in flight, with no code
change anywhere, and the job trains people to ignore it. That is worse than no test,
because a rolling baseline eventually contains every additive field the wire has, and
adding one is the sanctioned way to evolve it.

Derive the expectation from the baseline that was actually checked out:

- for a published frame, pair each build against a client of its own version and
  compare the skewed pairing against that same-version reference, so the expectation
  is whatever that build publishes today. Compare repeated frames by corresponding
  occurrence with `comparePublishedFieldOccurrences` in
  `tests/e2e/cross-version-wire/published-field-shape.ts`; never union keys across
  initial, reveal, and reconnect frames, because a sibling can mask one occurrence's
  removed field;
- for a negotiated surface, read the old build's advertised capabilities and
  registered method names from its checkout, and assert they agree with each other
  rather than asserting the old build lacks them;
- for a "client too old to know X", derive that client's advertised list by removing
  X from the baseline's own list, so the gate stays exercised after X ships.

Name the direction in the assertion. `new client against old server` and `old client
against new server` fail for different reasons, and the host is the only side that
authors a published frame — the terminal `terminalOwner` false positive on 2026-08-29
was misread as a new client sending an unknown field when the old server was
publishing it. Two things are still safe to state literally: the current build's own
contract, and an invariant that holds for every version.

Pinning a legacy ref is the fallback when a contract genuinely needs a release from
before a feature shipped, as `cross-version-browser-placement.unit.test.ts` does with
`LEGACY_BROWSER_PLACEMENT_RELEASE_REF`. It does not rot on a cut, but it is
hand-maintained, so prefer deriving.

`tests/e2e/cross-version-wire/cross-version-agent-session-wire.unit.test.ts` pairs the
same two builds over the structured `agentSession.*` surface. Because a released build
cannot name a capability string its own source never contains, the old side's advertised
list and registered method names are read from the extracted checkout rather than
hand-written. It covers the three skews that surface can fail on:

- an old client — advertising the baseline's list minus this capability — is told the
  whole surface does not exist and reaches no host method;
- a new client against the old dispatcher always gets an answer rather than silence,
  and `method_not_found` for every method that release does not register, so the
  absence is visible during negotiation instead of by calling;
- a cursor survives a host restart: the client's fence is refused as stale with the live
  one attached, and resuming from the held cursor replays only what it missed.

Run it with:

```bash
pnpm exec vitest run --config config/vitest.config.ts tests/e2e/cross-version-wire/cross-version-agent-session-wire.unit.test.ts
```

The harness covers the terminal stream and the structured agent-session surface. It does
**not** cover the session-tab sync channel, legacy agent-session publications, file or Git
RPCs, mobile/E2EE framing, or the relay transport. A change on those paths still needs its
own reasoning against the three rules above.

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
_unknown_ and never as _not waiting_. Collapsing absent into `null` at any hop — including a
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

## Known hazard: clients ignore host-published failure fields on client-placed pages

`RuntimeMobileSessionBrowserTab` — the browser tab a host publishes on the session-tab sync
channel — permits `placement`, `loadError` and `certificateFailure` together. But for a tab
whose `placement.kind` is `'client'` the engine runs in the client's own app: the failure is
raised by the local guest webview, and the host has no view of it (`RuntimeBrowserClientPage`,
what the registry actually publishes from, carries neither field). Clients from
this version on therefore refuse host ownership of both records for client-placed pages
(`web-session-tabs-sync.ts`, the `placement?.kind !== 'client'` carve-outs) — without that,
each metadata snapshot deletes the locally recorded failure and the page's failure overlay
disappears mid-navigation.

The hazard is forward-facing and Rule 3 shaped. A host that later starts publishing
`loadError` or `certificateFailure` for a client-placed page reaches these clients as content
they silently drop, so the host would see no error and no effect. Publishing it has to be
capability-gated, with the carve-out narrowed to clients that did not negotiate the
capability. Note the cross-version harness does not exercise the session-tab sync channel, so
nothing fails if this is forgotten — this note is the only record.

A related carve-out covers `title`, `url`, `loading`, `canGoBack` and `canGoForward`
(`resolveMirroredBrowserPageContent`), and for those the hazard is already live rather than
forward-facing: the host does publish them, from a `RuntimeBrowserClientPage` it can only learn
about second-hand through the client's own `browser.clientHost.pageMetadata` calls. Its copy
therefore starts at the registry defaults (`'Browser'`, the create-time url), and while those
publishes are failing it never leaves them.

That copy is not simply behind, though, and a client must not treat it as such. When a lease
reattaches, the host refreshes the page from the client host's own inventory
(`runtime-browser-client-page-recovery.ts`), which reads the live guest — so it can be strictly
fresher than a local row whose pane is unmounted and whose metadata publisher was disposed with
it. A client that ignores the host url is relying on its own guest to re-answer on remount,
which `ClientHostedBrowserPagePane`'s mount-time `syncNavigation` is what makes true.

These five are therefore refused only by the client whose guest actually runs the page:
`placement.browserHostClientId` is compared against this client's own host id
(`readBrowserClientHostId`). Main stamps that id into the guest-hosting window's
`additionalArguments` at creation, and the preload reads it back out of its own argv — the answer
has to be there before the first snapshot is interpreted, which is earlier than any IPC handler a
renderer could wait on. Every other viewer — a second desktop, the web client, which installs no
page renderer at all, the dashboard pop-out, which is deliberately left unstamped — keeps tracking
the host, which is the only reason a mirrored viewer shows anything but its first snapshot
forever. Improving what a _second_ client sees still means fixing the publish, not the carve-out;
the carve-out no longer stands in the way of it.

The two failure fields above are deliberately left on the looser `placement?.kind !== 'client'`
predicate. It is unobservable today — the host publishes neither field for a client-placed page at
all, so a mirror has nothing to take either way. If the capability-gated publish this section
anticipates ever lands, narrow them the same way rather than by placement kind: a mirror should
take a failure it cannot otherwise see, and only the hosting client should refuse it.
