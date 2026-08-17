# Plan — per-PTY send serialization (root cause of the glue/pending cluster)

**Status:** written AFTER implementation. See "Process note" at the bottom — this plan describes what was
actually built, not what was predicted. PR #14980 is open as a DRAFT pending this review.

**Branch:** `brennanb2025/fix-pty-send-lock` · **PR:** #14980 (draft) · **Diff:** `git diff origin/main...HEAD`

---

## 1. The bug

A terminal submit is three steps, and step 2 yields:

1. write the body (bracketed paste, or chunked text),
2. `await` the render gate — or, with no gate, `await` a fixed submit delay (500ms; 1500ms on Windows),
3. write `\r`.

Nothing serialized step 2 per PTY. Two overlapping sends to one pane interleaved across it: A's body landed,
A parked, B's body landed **on the same agent input line**, then A's `\r` submitted **A+B as one line**.

Orca therefore *manufactures* the merged transcript row that #14935 and #14936 reconcile downstream.

Measured before the fix, two `terminal.send` calls 499ms apart:

```
expected [ 'first messagesecond message', '' ]
      to deeply equal [ 'first message', 'second message' ]
```

---

## 2. What surprised me during implementation

This is the section the gate exists for. Everything here is a deviation from what the task spec predicted.

### 2.1 The named seam is not the seam that matters for mobile — scope doubled

The prior-art review named `writeTerminalAgentPrompt` as *the* write seam. **Mobile native chat never reaches
it.** In `src/main/runtime/rpc/methods/terminal.ts`, the settled agent-prompt path is gated on:

```ts
params.agentPrompt === true && … && params.client?.type === 'desktop'
```

Mobile sends `terminal.send` with `enter: true` and no `agentPrompt` (`mobile/src/session/mobile-native-chat-send.ts:69`),
so it routes to `sendTerminal` → `writeTerminalAction`, which has its **own identical gap**
(`await new Promise(r => setTimeout(r, 500))` before the suffix).

So the glue window exists on **two** write paths, and the one the STA-4492/#14936 mobile cluster actually
flows through is the one the review did *not* name. Fixing only `writeTerminalAgentPrompt` would have left
the mobile glue window fully open while appearing to fix the root cause.

**Decision:** serialize both paths onto **one shared per-`ptyId` queue**, so a desktop agent prompt and a
mobile send racing on the same pane are also serialized against each other. This is the single largest scope
delta from the spec and the first thing reviewers should attack.

### 2.2 A failed submit can still glue — the failure path is a hole I did not close

If a submit fails *after* its body is written but *before* Enter (a `beforeWrite` authority check throwing, a
chunk write returning false), the body text is **left sitting on the agent's input line**. The next queued
send then pastes on top of it — glue again, now originating from the failure path rather than the race.

`writeAgentPromptFrame` closes the bracketed paste (`AGENT_PROMPT_BRACKETED_PASTE_END`) on a chunk failure,
but does not clear the line. This is pre-existing behaviour, not introduced here — but serialization makes it
the *only* remaining Orca-manufactured glue path, so it is now the interesting one.

**Not fixed in this PR.** See §5 for the two precedents that disagree on the right answer, and §8 for what I
want reviewers to decide.

### 2.3 The existing test actively pinned the bug

`use-mobile-native-chat-drafts.test.ts` had a green test named `does not clobber newer edits when restoring a
rejected send` asserting the composer equals `'newer edit'` — i.e. asserting that the rejected send's text is
**gone**. The data loss was under test as correct behaviour. It is renamed and re-pointed, not deleted.

### 2.4 `use-mobile-native-chat-drafts.ts` was exactly at the 300-line cap

`max-lines` counts with `skipBlankLines`/`skipComments`, and the file was at exactly 300. The merge rule
therefore had to move to its own module (`mobile-native-chat-rejected-draft-merge.ts`) rather than growing the
hook. **No `max-lines` disable was added** — that is a hard rule. Incidental benefit: the rule became
independently unit-testable.

### 2.5 Two independent flaky failures, both CPU contention

`orchestration-creator-authority-performance` (wall-clock thresholds) and `mobile-image-base64-accumulator`
(5s timeout) failed only while several suites ran in parallel. Both pass in isolation. Neither is related.

---

## 3. Disposition for a send arriving while another is in flight: **QUEUED (FIFO)**

Not rejected with a typed error, not given an interrupt/steer disposition. Reasons, in priority order:

1. **It is the only option invisible to an older client.** The RPC response stays byte-identical — both sends
   return `accepted: true` with the same `bytesWritten`. No new field, no error code, no opcode, nothing to
   negotiate. See §6.
2. **Rejecting loses the user's text.** It would need a new `refusedReason` that shipped clients render as an
   unknown failure. On mobile the composer is cleared at send time, so an unclassifiable rejection is a lost
   message — the exact failure class this cluster exists to fix.
3. **Interrupt/steer is not expressible at this layer.** It needs a per-send disposition parameter on the wire
   (capability-negotiated), and the delivery channel is bracketed-paste bytes into a TUI's stdin. There is no
   way to tell a TUI "steer the current turn instead of appending". §5.3 shows the references put that choice
   at the *turn* layer, not the write layer.
4. **The wait is bounded.** Each slot is capped by the render gate's hard timer or the fixed submit delay, so
   a queued send cannot wait forever on a hung predecessor.

### What deliberately does NOT queue

Only a body→delay→suffix sequence owns a gap. Single-write actions stay unqueued:

| Action | Queued? | Why |
|---|---|---|
| text + Enter (a submit) | **yes** | owns the gap |
| agent prompt | **yes** | always a submit |
| bare interrupt (Ctrl+C) | no | a cancel held behind a queued send is useless; landing mid-gap correctly cancels that send's uncommitted body |
| bare Enter | no | single write, no gap |
| keystrokes, no Enter | no | live typing must not acquire a 500ms lock |

Consequence, stated plainly: **the downstream matchers stay necessary.** The user can still type into the TUI
by hand mid-send, and shipped clients keep producing glued rows against updated hosts. This removes the source
Orca controls, not every source.

---

## 4. Which existing idiom is reused

**`enqueueLayout` / `runLayoutSlot`** (`src/main/runtime/orca-runtime.ts:15692`), the per-PTY async
serialization queue for `applyLayout` — the same class, keyed the same way (`Map<ptyId, …>`), self-deleting on
drain for the same reason (bounded growth across short-lived PTYs).

**What is deliberately dropped: the coalescing.** `enqueueLayout` lets a queued tail be *superseded* by a
newer same-shape target (`coalescesWith`), because only the final layout matters. Prompts are the opposite —
every one must be delivered and none may be dropped. So the reuse is the queue shape, not `enqueueLayout`
itself, and it is ~20 lines rather than a call into it. I did **not** invent a new mechanism and did **not**
build a general-purpose lock library.

```ts
private terminalSubmitQueues = new Map<string, Promise<void>>()

private enqueueTerminalSubmit(ptyId: string, run: () => Promise<void>): Promise<void> {
  const previous = this.terminalSubmitQueues.get(ptyId) ?? Promise.resolve()
  const slot = previous.then(run)
  const tail = slot.then(() => undefined, () => undefined)   // absorb rejection; caller still sees it
  this.terminalSubmitQueues.set(ptyId, tail)
  void tail.then(() => {
    if (this.terminalSubmitQueues.get(ptyId) === tail) this.terminalSubmitQueues.delete(ptyId)
  })
  return slot
}
```

---

## 5. Precedent

Four comparable implementations examined. Reference projects are described generically per the secrecy rule.

### 5.1 A keyed per-resource serialization queue — structurally identical (strong precedent)

A major editor codebase serializes agent-host resource writes through a keyed queue:
`queueFor(resource, task)` over a `Map<key, Queue>`, where `Queue` is a limiter with concurrency 1.

Two details match this design exactly, which is the useful part:

- **The map entry is deleted when its queue drains** — same unbounded-growth concern, same fix.
- **The queue advances on rejection as well as fulfilment**, while the caller still receives its own error:
  `promise.then(task.resolve, task.reject); promise.then(() => this.consumed(), () => this.consumed())`.
  That is precisely my `slot.then(() => undefined, () => undefined)` tail + returning `slot`.

**Verdict: CONFORMS.** The implementation is the reference shape, arrived at independently.

### 5.2 Per-surface ordering barriers on PTY input — same problem domain (strong precedent)

An agent-IDE terminal multiplexer routes all PTY bytes and session mutations through one bounded scheduler,
documented as: *"Acknowledged surface operations run concurrently behind per-surface barriers, allowing
unrelated panes to keep accepting input while preserving each surface's order."*

That is this design's thesis, in the same problem domain (PTY input, not generic resources). It also
corroborates §3's exemption table: input is typed (`Ordered` / `Press` / `Motion` / `Release` / `Mutation`) and
the kinds are **not** treated alike — motion coalesces, press/release reserve capacity. Serializing everything
uniformly is not what the reference does either.

**Three places it is stricter than this PR** — each a real finding, not a footnote:

1. **The ordering key is versioned.** Its lane is `(session_generation, surface_id)`, not `surface_id` alone,
   so queued input cannot land on a session that was replaced underneath it. Mine keys on `ptyId` only.
   Orca mitigates this differently — a `ptyId` is unique per spawn and a write to a dead PTY returns false and
   throws — but the versioning is a cleaner guarantee. See §8.
2. **The queue is bounded** (512 operations / 4MB) with an explicit `Saturated` enqueue result. Mine is
   unbounded. See §8.
3. **A failed operation fails its whole lane** (`failed_lanes`, `lane_failed`), rather than letting the next
   item proceed. **This directly contradicts §5.1**, which advances past failures. Two references, two
   answers — and it bears exactly on the §2.2 hole, since "advance past a failure" is what lets the next send
   paste onto a line the failed send dirtied.
4. It also distinguishes `KnownNotDelivered` from `Ambiguous` delivery. Orca's mobile client already has this
   concept (`outcome === 'unknown'` → `holdUnconfirmedSend`), which is independent corroboration that the
   §7 draft-restore fix should fire only on a *definite* rejection. It does.

### 5.3 The three-value `interrupt | steer | queue` disposition exists — but one layer up

One reference exposes `SendBehavior = "interrupt" | "steer" | "queue"` as a **user setting**, consulted only
when `isAgentRunning`. That is a *turn*-level product decision (seconds to minutes: what should happen to the
agent's current turn), not a *write*-level one (milliseconds: are these two byte sequences allowed to
interleave). No reference offers interrupt/steer at the write layer; at the write layer they all serialize.

**This is the direct answer to "should the disposition be interrupt/steer?" — no, not at this layer.** It is a
legitimate future product question for Orca at the turn layer, and it is out of scope here.

### 5.4 The durable outbox — the cleanest contract, and a bigger change than this

One reference models sends as a durable outbox: `state: "queued" | "inflight" | "failed"`, `attempts`,
`lastError`, capped retries, `confirm(clientId)` on ack, `retry()` on failure. The composer is cleared once and
never written back to; a failed send stays as an editable, retryable row.

This is strictly better than both today's behaviour and §7's merge fix, and it is what a stuck pending bubble
in Orca should eventually become. It is a feature, not a fix, and it is not this PR.

### 5.5 Is there precedent for what we are NOT doing?

Per the gate's instruction to treat absence of precedent as a reason to reconsider: I looked specifically for
a reference that reconciles N optimistic sends against 1 merged row and **found none**, independently
confirming the prior review. The reason is uniform — none of them can *produce* a merged row, because each
send is a distinct correlated RPC, or carries a named disposition, or is queued behind a single-in-flight
dispatcher. **Nobody reconciles coalescing because nobody permits it.** That is the argument for this PR
existing at all, and it survived independent checking.

---

## 6. Mixed-version story (`docs/reference/remote-wire-compatibility.md`)

**No wire change.** Entirely host-side inside `OrcaRuntimeService`.

- **Rule 1** (new optional field): n/a — no field added.
- **Rule 2** (new opcode): n/a — no opcode added.
- **Rule 3** (host publishes different content): the host publishes the same response fields with the same
  values. Nothing that previously succeeded now fails. **This is the whole reason the disposition is *queue*
  and not *reject*** — a rejection would be a Rule 3 change an older client could not classify.

**What an older client sees when its send is queued:** exactly what it sees today, only later. Same
`accepted: true`, same `bytesWritten`. The one observable difference is latency — a concurrent send's ack
arrives after its predecessor drains, up to one submit delay later (~500ms; 1.5s Windows; or the render gate's
hard bound). Mobile's send deadline is 15s (`MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS`), so this is immaterial at
the concurrency this fixes. An ack that is genuinely lost already has the `holdUnconfirmedSend` path rather
than a false "not sent".

**Older host, newer client:** simply unfixed. It keeps gluing, and the downstream matchers handle it exactly
as they do today. No client-side change is required or made, so there is no version skew to negotiate.

**Direction of the fix:** host-side, which is the correct side — an updated host improves *every* client
including ones that never update.

---

## 7. Second fix — `restoreRejectedDraft` merges instead of dropping

It restored a rejected send's text **only if the composer was still empty**. The intent (never clobber text
typed during the rejection) is right, but the rejected text had **no other surviving copy** — the composer is
cleared at send time and a rejected send never reaches `acceptSend`. Skipping lost the message; the only trace
was a toast. Over relay/SSH that window is seconds.

Now merges, **ordered by authorship**: rejected text first, newer text on the following line
(`ping` + `newer edit` → `ping\nnewer edit`). An identical composer is returned untouched rather than
duplicated. Whitespace is preserved verbatim on both sides — trailing whitespace is load-bearing here, since
the host writes it onto the agent's input line, which is what #14262 is about.

Fires only on a **definite** rejection, never on `unknown` — consistent with §5.2's delivery distinction.

---

## 8. Open questions I want reviewers to decide

Listed because I did not resolve them, not because they are rhetorical.

1. **§2.2 — the failure path still glues.** A submit that dies between body and Enter leaves text on the input
   line for the next queued send to paste onto. §5.1 says advance past the failure (what I do); §5.2 says fail
   the whole lane. Failing the lane forever is too strong for Orca — a transient authority failure would brick
   the pane. Is a middle ground right: clear the input line on a mid-sequence failure, or mark just the *next*
   send on that PTY as needing a pre-clear?
2. **Unbounded queue.** §5.2's reference bounds at 512 ops / 4MB with a `Saturated` result. Mine is unbounded.
   Adding a cap means adding a rejection, which is the Rule 3 wire concern in §6. Is the unbounded queue the
   right trade, given each slot is individually bounded?
3. **Lane versioning.** §5.2 keys on `(generation, surface)`; I key on `ptyId`. Is `ptyId` uniqueness per spawn
   genuinely sufficient, particularly across a daemon restore or a relay reconnect?
4. **Scope (§2.1).** Serializing `writeTerminalAction` as well as `writeTerminalAgentPrompt` doubles the blast
   radius versus the spec. It is necessary for mobile, but it means every `terminal.send` with Enter now goes
   through a queue — orchestration dispatch, quick commands, diff-review sends. Is that acceptable, or should
   the mobile path be narrowed?
5. **The exemption table in §3.** Is letting a bare interrupt cut ahead of a queued submit right? It cancels
   that submit's uncommitted body, which I argue is what Ctrl+C should do — but it is a behaviour change in a
   race that previously had no defined outcome.

---

## 9. Hosts and workspace shapes

- **Local, SSH, relay:** the queue is keyed on `ptyId` inside the runtime that *owns* the PTY, which is the
  host in every topology. Serializing there covers every client, including ones that never update. No
  client-side or transport-side change.
- **Folder workspaces vs git worktrees:** nothing here is worktree-shaped. The keying is `ptyId`; no repo,
  branch, or worktree identity is consulted. Both behave identically.
- **Windows:** the submit delay is 1500ms rather than 500ms, so the queue wait per predecessor is 3× longer.
  Still far inside the 15s deadline. No platform-conditional code added.

---

## 10. What the deterministic tests assert

Mobile QA of the glued flow was reported **blocked**: emulator actions cost ~1.2–2.2s against a ~500ms window,
~10× too coarse to land a second send inside the gap. The answer is not a faster emulator — it is to make the
race a scheduling decision the test makes.

In `src/main/runtime/orca-runtime.test.ts`, on the existing fake-PTY + fake-timer rig:

| Test | Asserts | Reverted-production result |
|---|---|---|
| `does not glue two overlapping agent prompt sends into one submitted line` | park send A one tick short of its submit; start B; the bytes the fake PTY received split into exactly 2 submitted lines, and line 1 does **not** contain B's text | **RED** |
| `does not glue two overlapping terminal.send submits into one submitted line` | same, on the mobile path; `['first message', 'second message']` | **RED** |
| `lets a bare interrupt through while a submit holds the per-PTY queue` | `\x03` reaches the PTY before the held submit's `\r` | green (guard for §3) |
| `releases the per-PTY submit queue when a send fails mid-sequence` | a rejected submit does not jam the queue; the next send still succeeds | green (guard) |

Every pre-existing test in this cluster tests the *matcher* — a glued row is synthesized by hand and fed to the
reconciler. **Nothing tested that the glue happens.** These do, at the seam that creates it, with no device.

Mobile: `mobile-native-chat-rejected-draft-merge.test.ts` (6 unit tests) plus the re-pointed hook test.

---

## 11. Verification

| Gate | Result |
|---|---|
| `orca-runtime.test.ts` (full file) | 1166 passed, 1 skipped |
| mobile session suite | 1127 passed |
| terminal / RPC / orchestration suites | 444 passed |
| `typecheck` (node + cli + web) | clean |
| mobile `tsc --noEmit` | clean |
| `oxlint --deny-warnings`, changed files | clean — liveness confirmed by injecting a violation, since oxlint is silent when clean |
| `lint:react-doctor` | no findings on changed files |
| `check:max-lines-ratchet` | OK, no new bypasses |
| `audit:code-quality:native` | clean |
| **merged with #14936, mobile session suite** | **132 files, 1177 passed** — materialized, not just `merge-tree` |

**Non-vacuity** — production reverted, tests kept: **3 RED** (both interleaving tests + the draft merge test).
**0 failed merely on a missing export**: `TERMINAL_SEND_SUBMIT_DELAY_MS` and the merge module were deliberately
retained during the revert. Two runtime tests stay green under revert **by design** — they guard the §3
exemptions, they are not regression tests for the lock. The 6 merge-module unit tests likewise stay green
because the module is intact; the hook test is what proves the wiring.

**Conflict check with the sibling PRs:** `git merge-tree` against both #14935 and #14936 heads is clean.
`use-mobile-native-chat-drafts.ts` is shared with #14936, but their hunks are at lines 1–16, 138–141 and
291–322; this PR touches line 22 (one import) and 158–163 (`restoreRejectedDraft`), which #14936 does not
modify.

---

## 12. Process note

This plan was written **after** implementation, which inverts the plan-first gate. That was my error: I worked
straight through the task spec's "reproduce first, then fix" ordering and did not check the orchestration inbox
between phases, so three messages amending the order sat unread for ~17 minutes, and PR #14980 was opened
before any reviewer saw anything.

The PR has been converted to **draft**. The gate's purpose — independent reviewers getting to say "wrong
approach" while it is still cheap to change — is served by reviewing this document **together with the actual
diff**, which is a more honest artifact than a plan predicting it. §8 lists the five things I genuinely have
not resolved. If a reviewer says the approach is wrong, the code changes.

## 13. Reviewer findings

*Populated by the review loop. Records what was accepted, what was rejected, and why.*
