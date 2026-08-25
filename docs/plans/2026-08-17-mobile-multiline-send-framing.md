# Plan — frame multi-line mobile native-chat sends as one paste

Status: **REVIEWED — CLEAN.** Not implemented. Five review rounds; see §11.
Date: 2026-08-17
Defect: (A) from the mobile "double sending" investigation.

## 1. The defect

`mobile/src/session/mobile-native-chat-send.ts:64-77` sends the composer body as a
raw string with `enter: true`:

```ts
text: args.clearInputFirst ? `${CLEAR_UNSUBMITTED_INPUT}${args.text}` : args.text,
enter: args.enter ?? true,
```

The composer that feeds it is `multiline` (`MobileNativeChatComposer.tsx:213`) with no
`onSubmitEditing`, so the keyboard's Return key inserts a literal newline into the
draft and sending is a separate button tap. Nothing between the composer and the wire
removes interior newlines — `use-mobile-native-chat-message-send.ts:98` only does
`draftText.trimEnd()`.

The host treats `text` as opaque bytes. `terminal.send` →
`orca-runtime.ts:18189 writeTerminalAction` → `writeTerminalInputChunks` →
`iterateTerminalInputChunks` (`src/shared/terminal-input.ts:64`) is pure UTF-8 chunking
with no transformation, then `ptyController.write`. The host's framed-prompt path
(`sendTerminalAgentPrompt` → `buildAgentPromptPasteBytes`) is gated on
`params.client?.type === 'desktop'` (`src/main/runtime/rpc/methods/terminal.ts:1362`),
so mobile is structurally excluded from it.

Result: a two-line draft reaches the agent TUI as `line1` + Enter + `line2` + Enter —
**two separate submissions from one tap.** This is duplicate DELIVERY, not just display.
It also pins the optimistic bubble forever, because the pending key normalizes to
`"line1 line2"` while the transcript holds two turns.

Desktop does not have this bug: `src/renderer/src/components/native-chat/native-chat-send.ts`
wraps a multi-line draft via `wrapTerminalBracketedPasteText` before writing.

### Confirmed reproduction

`mobile/src/session/mobile-native-chat-multiline-send.repro.test.ts` (currently
untracked scratch) pins both halves — mobile emits a raw `\n` unframed with
`enter: true` while the desktop builder frames the identical draft, and the bubble
survives a split transcript. 4/4 green.

### Additional call sites with the same defect

Same shape, same fix, different callers:

- `mobile/src/session/use-mobile-diff-review-send-actions.ts:83` — sends
  `formatMobileDiffReviewPrompt(comments)`, which is `[...].join('\n')`
  (`mobile-diff-comments.ts:26-37`). **Guaranteed** multi-line, ~9 lines. Every mobile
  diff-review "send notes" today fires ~9 separate agent submissions.
- `mobile/src/session/pr-ai-triage-launch.ts:31` — sends a triage prompt into a fresh
  agent terminal with `enter: true`.

See §7 for the sequencing decision on these.

## 2. Precedent

Read via the local OSS reference mirror. External projects are deliberately not named
here, in commits, or in any PR text.

**Finding 1 — framing is owned by the sending client, at the input seam, and no
surveyed implementation frames on the receiving side.** Three independent terminal
frontends (a mainstream editor's integrated terminal, a client/server terminal
workspace, and a cross-platform terminal app) all apply the wrap immediately before
writing to the process, gated on the receiving application's declared bracketed-paste
mode. In the client/server one, the server component carries only configuration keys
for the feature — the framing itself lives entirely in the frontend. I found **no
precedent for a host/server wrapping text on receipt.**

**Finding 2 — the wrap alone is not sufficient; line endings must be normalized too.**
The editor's send path does:

```
// Apply bracketed paste sequences if the terminal has the mode enabled, this will prevent
// the text from triggering keybindings and ensure new lines are handled properly
if (force && modes.bracketedPasteMode) { text = `\x1b[200~${text}\x1b[201~` }
// Normalize line endings to 'enter' press.
text = text.replace(/\r?\n/g, '\r')
```

Both steps, in that order. Orca's own `wrapTerminalBracketedPasteText` already encodes
the identical recipe and states the reason: *"xterm's native paste path converts every
clipboard newline to CR. Direct frames must match it or ConPTY TUIs can treat raw LF as
submit."* So a plan that only wraps, without normalizing `\n` → `\r`, would still be
wrong on some receivers.

**Finding 3 — the receiving agent TUI's own source confirms the failure mode and shows
that the fallback is unreliable.** A reference agent TUI documents that on terminals
which "don't provide reliable bracketed paste (notably Windows)", pastes arrive as a
rapid sequence of character and Enter key events, and it must "ensure Enter is treated
as a newline *inside the paste*, not as 'submit the message'." Its fallback is an
explicitly timing-and-count based burst detector with two timeouts. That is exactly the
mechanism our unframed multi-line body depends on today — and it is a heuristic keyed on
inter-character timing, which a chunked write over SSH or relay cannot satisfy. This is
independent confirmation that bracketed-paste framing is the intended signal and that
relying on the fallback is not sound.

**Finding 4 — "always frame a paste" is the norm; "frame only when multi-line" is
Orca's own narrowing.** The surveyed implementations frame every paste when the mode is
on, not only multi-line ones. Orca's desktop native chat frames only multi-line drafts.
This plan keeps Orca's narrower rule (§4, decision D3) for blast-radius reasons, which
means it is *more* conservative than precedent, not less.

**No missing-precedent gap.** Every element of the proposed change — client-side
framing, at the input seam, wrap + line-ending normalization + escape sanitization — is
attested both externally and already inside Orca on the desktop path. The one place
this plan departs from external precedent is D2 (unconditional rather than
mode-gated), argued there.

## 3. Wire compatibility — the crux

Read against `docs/reference/remote-wire-compatibility.md`. Mobile and desktop hosts
update independently; mobile ships through an app store and can be arbitrarily newer
than the desktop it pairs with.

### What happens on an old host

**Nothing changes for the host.** `terminal.send`'s `text` has been opaque bytes on
every version: the handler never parses it, and the runtime writes it verbatim. The
only host code that looks at `text` at all is

- `assertTerminalSendTextWithinLimit` — a byte cap (16 MiB, enforced at
  `rpc/methods/terminal.ts:299-306` before the write). **Corrected in round 3: the payload
  can grow, not only shrink.** Framing adds 12 bytes; `\r\n` → `\r` shrinks by one byte
  per CRLF; but ESC sanitization replaces a 1-byte ESC with a 3-byte U+241B, **adding two
  bytes per ESC**. A draft sitting just under the ceiling could therefore be newly
  rejected. §9 covers this with a near-limit test; if that proves awkward, the fallback is
  an explicit client-side headroom policy. In practice the ceiling is 16 MiB and mobile
  drafts are kilobytes, so this is a correctness-of-reasoning fix rather than a live risk;
- `isTerminalQueryReply(params.text)` — reached only when `inputKind === 'query-reply'`,
  a path this change does not touch.

The RPC schema declares `text` as a plain optional string
(`src/main/runtime/rpc/methods/terminal.ts:895`), and the runtime writes it verbatim
through `buildSendPayload` → `writeTerminalAction` → `iterateTerminalInputChunks`.

**This is not only a code-reading argument — it is already proven in production.**
Mobile ships bracketed-paste bytes (including raw ESC) through this exact RPC today, on
two paths: the native-chat image paste (`mobile-clipboard-image.ts:177`) and the
mode-gated terminal clipboard paste (`use-mobile-terminal-paste.ts:60`). Those reach
hosts of every vintage and land intact. The new-client/old-host pairing this change
creates is therefore an existing, exercised configuration, not a novel one.

So a mobile client emitting framed bytes to a host that predates the change lands those
bytes in the PTY exactly as intended. The component that must understand the frame is
the **agent process at the far end**, whose behaviour is a function of the agent's own
version, not of the host's Orca version.

### Rule-by-rule

- **Rule 1 (new optional field):** not applicable. No new field.
- **Rule 2 (new stream opcode):** not applicable. This is the `terminal.send` RPC
  method, not the binary terminal stream. No opcode is added, and the silent-drop
  hazard that motivates negotiation does not exist on this path.
- **Rule 3 (changed content over an unchanged frame):** **not literally triggered.**
  Corrected in round 3: the document defines Rule 3 as changing what *the host publishes*
  to old clients (`remote-wire-compatibility.md:61-76`). This change alters what a *client
  sends to a host* — the opposite direction — so no rule applies verbatim.

  The right framing is that this is a **client-to-host analogue of Rule 3**, and it is the
  only one of the three that is even structurally relevant. Applying the same test — can
  the receiving side misinterpret the new content? — the answer is no: the host is a byte
  pipe that never interprets `text`. So the analysis Rule 3 would demand is satisfied, and
  no capability gate is needed. The conclusion is unchanged; only the label was overstated.

### Does it need capability negotiation? No — and negotiation would not help

A capability handshake would tell mobile whether the *host* understands framing. The
host's understanding is irrelevant; it never interprets these bytes. The property that
actually matters — whether the agent TUI honours bracketed paste — is not something the
host advertises, is not versioned with Orca, and can change when the user upgrades their
agent CLI independently of both. Gating on a host capability would add a negotiation that
answers the wrong question while leaving the real one unanswered.

### Which side should own the framing? — argued, not assumed

**Decision: the client (mobile).** Considered alternative: have the host frame on
receipt when `client.type === 'mobile' && enter === true` and the text is multi-line.

Rejected, for four reasons:

1. **It fixes nobody who has the bug.** Mobile updates through an app store; the paired
   desktop updates on its own schedule and may never update. A host-side fix helps only
   pairs where the *desktop* has updated. A client-side fix works against every host
   including ones that never will — which is the direction the version skew actually
   runs for this defect.
2. **It is itself a Rule 3 host-behaviour change reaching old clients**, and it creates a
   double-framing hazard: once mobile also frames (which it must, per 1), a host that
   frames on receipt would wrap an already-wrapped body.
3. **The host cannot tell prose from a shell command.** `ai-vault-resume-launch.ts:181`
   sends a shell command to a shell over the same RPC; `formatMobileDiffReviewPrompt`
   sends prose to an agent TUI. Framing the former is wrong. Only the caller knows which
   it is issuing. This is the decisive argument — and it is worse than a knowledge
   problem: both of those call sites omit the `client` field entirely, so a host-side
   rule keyed on `client.type === 'mobile'` could not even identify them as mobile.
4. **No precedent.** No surveyed implementation frames on the receiving side (§2,
   Finding 1); all frame at the sending input seam.

## 4. Design

### D1 — where the code lives: `src/shared/`

New module `src/shared/agent-tui-paste-framing.ts`, exporting the wrap recipe.

Rationale: this is a property of the agent TUIs, not of either client — the same
rationale already written at the top of `src/shared/agent-tui-input-clear.ts`
(*"Shared by desktop native chat and mobile: the law below is a property of the agent
TUIs, not of either client"*). That module is the direct precedent for placing an
agent-TUI byte law in `src/shared` and consuming it from both clients. Mobile already
imports from `src/shared` (e.g. `buildAgentTuiClearInputForText`,
`isSlashCommandDraft`), so no new dependency direction is introduced.

The recipe is an extraction of the pure functions already in
`src/renderer/src/components/terminal-pane/terminal-bracketed-paste.ts`:
`normalizeTerminalPasteLineEndings`, `sanitizeBracketedPasteText`, and the
`wrapTerminalBracketedPasteText` composition. Those three are free of `@xterm/xterm`
runtime dependencies (the file's xterm import is a type-only import used by other
exports), so the extraction is mechanical.

To keep desktop churn at zero, `terminal-bracketed-paste.ts` should **re-export** the
three moved functions rather than have their five renderer consumers repoint their
imports (`agent-paste-draft.ts`, `agent-draft-paste-content.ts`,
`terminal-drop-path-writer.ts`, `native-chat-send.ts`, plus the module's own
`forceBracketedPaste`). One definition serves both clients, and no desktop call site
changes — which makes "desktop behaviour is unchanged" a property of the diff rather
than something the tests have to establish.

Note a pre-existing divergence, explicitly **not** in scope: `src/shared/agent-prompt-injection.ts`'s
`buildAgentPromptPasteBytes` frames and sanitizes ESC but does *not* normalize line
endings, and `mobile-clipboard-image.ts`'s `buildMobileImagePastePayload` frames and
sanitizes but does not normalize (its payloads are single-line paths). Unifying all
three recipes is a separate change; this plan adopts the one desktop native chat
already uses for exactly this case.

### D2 — frame unconditionally when multi-line, not gated on PTY modes

External precedent gates on the receiver's declared bracketed-paste mode; Orca's mobile
*terminal* paste path does the same (`use-mobile-terminal-paste.ts:64`). This plan does
**not**, for three reasons:

1. **Desktop native chat already frames unconditionally** for this exact surface. Matching
   it is the point of the change; diverging would leave a second asymmetry.
2. **Native chat has no reliable mode signal at send time.** The mode lives in
   `ptyModesRef`, populated by the terminal stream subscription. Native chat is a
   different view and the value can be absent or stale when the send fires; a stale
   `false` would silently reinstate the bug.
3. **The failure mode of framing unnecessarily is strictly better than the status quo.**
   If the agent TUI has exited and a shell is at the prompt, an unframed multi-line body
   today executes each line as a shell command. A framed one is inserted literally by any
   readline that honours the mode. Framing does not make that case worse; it makes it
   safer.

### D3 — framing is an explicit opt-in from the prose call site, never inferred

**Revised after review round 1 — the original "frame whenever `/[\r\n]/` matches" gate
was wrong and would have broken two shipping features.**

`sendMobileNativeChatMessageWithOutcome` is not only the composer's transport. Two
callers push a **bare `'\r'`** through it as `text` with `enter: false`:

- the slash-command submit key — `typeAgentTuiCommand` builds
  `[AGENT_TUI_CLEAR_INPUT_LINE, ...command, '\r']` and writes one key per RPC
  (`src/shared/agent-tui-command-typing.ts:29`), routed through
  `typeMobileNativeChatCommandWithOutcome` (`mobile-native-chat-send.ts:106-123`);
- every paced ask answer — `ASK_ENTER = '\r'` (`src/shared/native-chat-ask.ts:185`),
  sent at `use-mobile-native-chat-answer-send.ts:173-190` with the group's own `enter`.

A bare `'\r'` matches `/[\r\n]/`. Under the original gate it would have been framed into
`\x1b[200~\r\x1b[201~`, which a TUI inserts as paste-content newline instead of
committing — silently breaking **Codex slash-command dispatch and every Claude/Codex
selector answer from mobile.**

Adding `enter === true` to the gate is not sufficient either: the non-stepping ask branch
sends `formatAskAnswer(prompt, selections)` with `enter: true`
(`use-mobile-native-chat-answer-send.ts:258`), and that string is newline-joined for
multi-question prompts (`src/shared/native-chat-ask.ts:172-173`). It would silently start
being framed by a change that was never reasoning about it.

**Decision:** add an explicit opt-in argument (e.g. `framePasteWhenMultiline?: boolean`)
to `MobileNativeChatSendArgs`. The wrap applies only when the caller passes it **and**
`/[\r\n]/` matches. Only the prose call sites opt in. Every other caller of this
function is unchanged **by construction**, not by a predicate that happens to exclude
them today.

**The complete caller set** — "every other caller is unchanged" is a central guarantee,
so it is enumerated rather than asserted. Six call sites reach this transport:

| Caller | Opts in? |
|---|---|
| `use-mobile-native-chat-message-send.ts:185` — composer prose | **Yes** |
| `mobile-native-chat-send.ts:94` — `sendMobileNativeChatMessage` boolean wrapper | No (part of the public seam; must stay byte-identical) |
| `mobile-native-chat-send.ts:111` — per-key slash-command typing | No |
| `use-mobile-native-chat-answer-send.ts:173` — paced ask groups | No |
| `use-mobile-native-chat-cancel-ask.ts:27` — ask cancellation (Escape) | No |
| `mobile-native-chat-permission-send.ts:20` — permission responses | No |

§9 asserts byte-identity through the public function for the Escape and permission
sequences too, not only the command/answer cases.

**This seam does not reach PR 2's paths — and that is by design, not an oversight.**
Clarified in round 4. All three PR 2 prose paths call `client.sendRequest('terminal.send',
…)` **directly**, bypassing this transport entirely:
`use-mobile-diff-review-send-actions.ts:83`, `pr-ai-triage-launch.ts:31`, and the
`initialPrompt` send at `[worktreeId].tsx:3756`. Changing only the D3 function would leave
all three raw.

So the shared module (D1) must export the framing as a **pure function**, and each prose
call site applies it explicitly at its own call site — the same opt-in principle, expressed
as a call rather than a flag. The `framePasteWhenMultiline` argument on
`sendMobileNativeChatMessageWithOutcome` is simply the native-chat transport's wrapper over
that function. PR 2 must not attach framing to the `initialPrompt` seam itself, because
that seam is overloaded (see §7); the diff-review caller opts in, the quick-command caller
never does.

This is the single most important revision in the plan, and it is exactly the #14819
failure mode (§5): a change that altered behaviour for call sites its author was not
thinking about.

Precedent would support always-framing (§2, Finding 4), but single-line sends dominate
this seam and changing their bytes fixes no defect. Narrower is right here.

### D4 — frame in the transport module, downstream of reconciliation

The wrap happens inside `sendMobileNativeChatMessageWithOutcome`, on the value placed in
the RPC `text` field — **not** in `use-mobile-native-chat-message-send.ts`. The opt-in
flag from D3 is passed *in*; the byte construction stays in one place.

This is load-bearing. `captureSendOrigin(text)`, `acceptSend(origin, text, images)` and
the pending record must continue to see the user's plain text, so the optimistic bubble
and its reconciliation key are byte-identical to today. Only the outgoing wire payload
differs.

### D5 — the clear prefix stays outside the frame

Current code builds `` `${CLEAR_UNSUBMITTED_INPUT}${args.text}` ``. After the change it
must be `` `${CLEAR_UNSUBMITTED_INPUT}${wrap(args.text)}` `` — Ctrl+U before the paste
start, never inside it. Wrapping `\x15 + text` together would send the kill byte as
paste *content*.

Sketch:

```ts
const body = shouldFrame(args.text) ? wrapAgentTuiPaste(args.text) : args.text
text: args.clearInputFirst ? `${CLEAR_UNSUBMITTED_INPUT}${body}` : body,
enter: args.enter ?? true,
```

### D6 — `enter: true` is retained; the host already separates the submit

Desktop's contract is that the submit must be a *separate, slightly delayed* write,
because a `\r` inside the same write as a framed body is absorbed as paste content. The
host already does this: `writeTerminalAction` writes the text, `await sleep(500)`, then
writes `\r` as its own `ptyController.write` (`orca-runtime.ts:18783-18797`). So
`enter: true` already produces the required shape and no second RPC is needed.

## 5. Why this seam is dangerous, and how this avoids repeating #14819

#14819 (`432b7a6ada`) reverted #14665 (`68ca17e46c`) — a change to this same mobile send
path — as launch-blocking. Its real cause was a `glueBaselineTrusted` flag **captured
once at send time and never re-evaluated**, which permanently disqualified any send
issued during transcript hydration from ever retiring, stranding it as a visible queued
bubble and as a glue barrier for its neighbours.

Its other stated cause — a rejected send eating draft text — is a phantom. Both halves
verified directly, and they are complementary rather than contradictory (round 5 read them
as being in tension):

- `git show 68ca17e46c -- mobile/src/session/use-mobile-native-chat-message-send.ts` shows
  the only changes were adding `const text = rawText.trimEnd()` **inside** `sendMessage`
  and swapping `recordCommand(text.trim())` for `recordCommand(text)`. The
  `restoreRejectedDraft` call was never touched.
- `git show 68ca17e46c^:mobile/src/session/MobileNativeChatComposer.tsx` shows the sole
  production caller **already** passed `onSend(value.trimEnd())`.

So the added trim was idempotent and the restore was byte-identical to main's.

How this plan avoids that class:

- **No new persisted state.** The framing decision is computed per-write from the text
  and discarded. There is no captured flag, no new field on
  `MobileNativeChatPendingMessage`, nothing that can go stale.
- **No change to the reconciliation inputs.** Per D4, `origin.normalizedText`,
  `baselineOccurrences`, `baselineTailMessageId`, `expectedOccurrence` and the pending
  record are untouched. The retirement predicate sees exactly what it sees today.
- **The #14819 restore contract is preserved.** `draftText` remains what the user typed;
  only the bytes that go out are transformed, and the transformation now happens even
  further downstream than the `trimEnd` did.
- **A revert is a one-line revert** of a pure byte-construction change, with no state
  migration.

## 6. Interaction with (B), the inflated-ordinal pin

(B) is the separate, still-open duplicate-*display* defect: `captureSendOrigin` counts
occurrences against `messagesRef.current` even when that is still the previously active
tab's transcript, producing an inflated `expectedOccurrence`; and
`rebaseMobileNativeChatPendingBaselines` explicitly does not recount it
(*"The ordinal is deliberately NOT recounted"*).

**Fixing (A) removes a pinned-bubble mode rather than creating one.** Today a 2-line send
produces 2 transcript turns and the pending key (`"line1 line2"`, whitespace-collapsed)
matches neither → permanent pin. After the fix there is 1 transcript turn carrying the
whole draft, and `normalizeNativeChatUserText` collapses `\s+` → `' '` on both sides, so
the key matches and the bubble retires normally.

The `\n` → `\r` normalization is invisible to reconciliation for the same reason: `\r`
and `\n` are both `\s`, so both sides collapse identically. **This must be asserted by a
test** (§8), not assumed.

(B) itself is untouched and stays open. It is a different mechanism (ordinal accounting,
not bytes) and belongs in its own PR.

### 6.1 — ESC sanitization DOES create a new pin, and must be fixed here

**Added after review round 2. The §6 promise above was false as originally written.**

`wrapTerminalBracketedPasteText` sanitizes by replacing every raw ESC with U+241B
(`terminal-bracketed-paste.ts:51-66`) — necessary, because an embedded `\x1b[201~` would
otherwise close the frame early and run the tail as keystrokes. But D4 deliberately keeps
the **pending** record's text plain. So for a multi-line draft containing ESC:

- the pending key retains raw `\x1b`;
- the agent receives, and its transcript records, `␛` (U+241B);
- `normalizeNativeChatUserText` only trims and collapses whitespace
  (`src/shared/native-chat-image-transcript-markers.ts:39-41`) — it does not relate the
  two.

The keys never match and **the bubble pins forever** — precisely the failure class this
plan exists to remove. Reachable by pasting terminal scrollback into the composer, which
is a normal thing to do on this surface.

**Decision:** make the reconciliation key ESC-equivalent by normalizing raw ESC to U+241B
inside `normalizeNativeChatUserText`, so both sides collapse to the same key. This is
symmetric, one place, and the risk of a false match is negligible (U+241B is not a
character users type). Note it also closes the same latent case on desktop, which uses the
identical sanitizer and normalizer.

This is in scope for this PR rather than a follow-up: without it the framing change
introduces a regression, so it is part of "one thing", not a second thing. §9 covers it
with a RED/GREEN pair and its own mutation check.

## 7. Blast radius

Every mobile path that writes to a PTY, classified.

**Changed — agent-composer prose, `enter: true`, can be multi-line:**

| Path | Note |
|---|---|
| `mobile-native-chat-send.ts` `sendMobileNativeChatMessageWithOutcome` | Primary. Serves the composer text send and the text body of an image send. |
| `use-mobile-diff-review-send-actions.ts:83` | Diff notes to an **existing** terminal. `formatMobileDiffReviewPrompt` is `[...].join('\n')`. Always multi-line. |
| `[worktreeId].tsx:3754-3762` — the `initialPrompt` send, **prose caller only** | **Found in round 2; scoped correctly in round 3.** Sends `options.initialPrompt` with `enter: options.enter !== false`. The diff-review "send notes to a NEW agent" action sets `pendingDiffNotesDelivery.prompt = formatDiffComments(comments)` (`:2066`) and passes it as `initialPrompt` (`:4273`); `formatDiffComments` joins with `'\n\n'` (`src/shared/diff-comments-format.ts:33`). Multi-line prose into a fresh agent TUI with Enter. Distinct from the row above — that one targets an existing terminal, this one a new tab. **See the warning below: this seam is overloaded and must not be framed on its own identity.** |
| `pr-ai-triage-launch.ts:31` — `createTerminalAndSendPrompt` | Prompt into a fresh agent terminal. **Two consumers, not one:** PR triage (`use-mobile-pr-ai-triage.ts:42`) and commit-failure recovery (`use-mobile-commit-failure-recovery.ts:59`). Framing belongs in the shared helper so both are covered. |

> **`initialPrompt` is overloaded — PR 2 must opt in at the caller, never at the seam.**
> Found in round 3. The same send at `[worktreeId].tsx:3754-3763` also carries **shell
> commands**: `buildMobileQuickCommandLaunch` sets `initialPrompt: command.command` with
> `enter: false` for an `appendEnter === false` quick command
> (`mobile/src/terminal/quick-commands.ts:66-72`), and that command may itself be
> multi-line. Framing it would corrupt an insert-only shell quick command.
>
> This is the same lesson as D3 one level up: the transport cannot infer intent, so the
> opt-in must be passed by the diff-review caller specifically — not attached to the
> `initialPrompt` seam. (The `appendEnter !== false` quick-command branch is unaffected
> for a second reason: it flattens multi-line bodies via `flattenTerminalQuickCommand`
> before sending.) §9 requires a regression test that a multi-line insert-only quick
> command stays byte-identical and unframed.

**Sequencing decision (needs a call):** one defect and one fix, but now **four** distinct
prose call sites. Recommendation — **PR 1** = shared framing module + the ESC key fix
(§6.1) + `mobile-native-chat-send.ts` (the reported defect); **PR 2** = the three launch
and diff-review prose paths, which share a mechanical shape and their own tests. This
keeps PR 1 to the reported symptom per one-thing-per-PR. The risk of splitting is that
PR 2 is forgotten, so it must be filed before PR 1 merges. Round 2 finding it late is
evidence this inventory is easy to under-count — PR 2 should re-derive it by grep, not
by copying this table.

**Deliberately not changed:**

| Path | Why |
|---|---|
| `ai-vault-resume-launch.ts:181` | A **shell command to a shell**. Framing would be wrong. |
| `typeMobileNativeChatCommandWithOutcome` | Types one character per write, `enter: false`; slash commands are single-line. |
| `clearMobileNativeChatInput` | Control bytes only. |
| `pasteMobileNativeChatImagePaths` | Already framed (`buildMobileImagePastePayload`). |
| `use-mobile-native-chat-answer-send.ts` paced groups (`:173-190`) | `sanitizeAskFreeText` flattens newlines for `{text}` groups; `ASK_ENTER` groups are a bare `'\r'`. Must not opt in (D3). |
| `use-mobile-native-chat-answer-send.ts` non-stepping branch (`:258`) | **Has the same defect today** — `formatAskAnswer` is newline-joined for multi-question prompts and goes out with `enter: true`. Deliberately **not** opted in here: it is a different contract (selector commit, not composer prose) and needs its own reasoning. File separately; the D3 opt-in guarantees it cannot change by accident. |
| `mobile-native-chat-permission-send.ts` | Single keystrokes. |
| `use-mobile-native-chat-stop.ts:98` | Interrupt byte. |
| `mobile-terminal-query-reply.ts:43` | Query-reply bytes, `inputKind: 'query-reply'`. |
| `mobile-image-attachment.ts:54` | Attachment write, already framed upstream. |
| Terminal-view composer `handleSend` (`[worktreeId].tsx:2957`) | Targets a shell, single-line `TextInput`. |
| `sendLiveTerminalInput` | Per-keystroke mirror deltas, `enter: false`. |
| `terminal-live-accessory-raw-send` | Control bytes. |
| `use-mobile-terminal-paste.ts` | Already frames, mode-gated. |

**Voice dictation:** has no PTY path of its own. It writes into whichever composer is
focused, so native-chat dictation inherits the fix automatically. Dictation that inserts
line breaks is in fact one of the likelier ways to hit the original defect.

**Quick commands:** deliver via `session.tabs.createTerminal { agentPrompt }`, which the
host injects through `sendTerminalAgentPrompt` / `buildAgentPromptPasteBytes` — already
framed, host-side, on a different mechanism. Unaffected.

## 8. SSH, remote hosts, folder workspaces

The change is entirely in the bytes the mobile client publishes; where the PTY lives is
irrelevant to it. It applies identically to a local git worktree, a folder workspace, an
SSH host, and a relay-connected remote, because all four terminate at the same
`terminal.send` → `writeTerminalAction` path.

Two transport-specific considerations:

1. **Chunking across the frame.** `iterateTerminalInputChunks` splits at 16 KiB, so a
   large framed draft's `\x1b[200~` and `\x1b[201~` land in different writes with a
   `setTimeout(0)` between them. This is fine — the PTY is a byte stream and the agent's
   parser is streaming — and it is the same shape the existing image-paste and
   agent-prompt paths already produce. Worth an explicit test at >16 KiB.
2. **ConPTY submit timing on Windows hosts — a real risk.** `writeTerminalAction` uses a
   **hardcoded 500 ms** before the Enter. The repo's own platform-aware constant
   (`getAgentPromptSubmitDelayMs`) uses **1500 ms on win32**, with the reason written
   down: *"ConPTY renders long bracketed pastes more slowly; an early Enter leaves the
   task in the agent input buffer."* A large multi-line draft from mobile to a Windows
   host could therefore submit before the paste finishes rendering, leaving the message
   in the input buffer unsent — and the composer has already been cleared, so it would
   look like a silent drop.

   Mitigating facts, both verified: `pasteMobileNativeChatImagePaths` already sends
   bracketed pastes through the same 500 ms path to Windows hosts today (short payloads);
   and more decisively, **desktop native chat itself uses a flat, platform-independent
   500 ms** for the identical framed-body-then-Enter shape —
   `NATIVE_CHAT_SUBMIT_DELAY_MS = 500` at `src/shared/native-chat-answer-stepping.ts:1`,
   applied at `native-chat-runtime-send.ts:152`. So mobile framing brings this seam to
   **parity with desktop's already-shipped risk profile** rather than creating a new
   exposure. The 1500 ms win32 constant is used only by the host's separate
   `sendTerminalAgentPrompt` path.

   Decision: **ship (A) as specified and file the platform-aware suffix delay in
   `writeTerminalAction` as a separate follow-up.** Widening the host's delay is a
   host-side behaviour change with its own compatibility reasoning and does not belong in
   a mobile byte-construction PR. Flagged here so it is not lost. Reviewers should push
   back if they think this ordering is wrong.

## 9. Test plan

Mobile tests run under `mobile/vitest.config.ts` (mobile has its own config and
oxlintrc). Shared/desktop tests run under `config/vitest.config.ts`.

Corrected after review round 1: two of the original "RED" items were invariants that
already pass today, and the line-ending mutation had no distinct catcher.

**Genuinely RED before the fix** (each fails today, for the stated reason):

1. **Frame delimiters.** An opted-in multi-line body produces an RPC `text` starting with
   `\x1b[200~` and ending with `\x1b[201~`. Today: no delimiters. *Catches: frame removed.*
2. **Line-ending normalization.** That same payload contains **no `\n` at all** — every
   separator is `\r`. Today: a raw `\n` survives. Distinct from test 1: deleting only the
   normalization step leaves test 1 green and turns this one red. *Catches: normalization
   removed.*
3. **Clear prefix placement.** With `clearInputFirst: true`, the payload is `\x15`
   immediately followed by `\x1b[200~` — the kill byte outside the frame (D5). Today there
   is no frame to be outside of. *Catches: `\x15` moved inside the frame.*
4b. **ESC in a multi-line draft still retires (§6.1).** Send a multi-line draft containing
   a raw ESC; assert the wire payload carries U+241B, and that the pending key and a
   transcript turn recording U+241B normalize equal so the bubble retires. Today there is
   no frame and no sanitization, so the sanitized-vs-raw mismatch this guards cannot yet
   arise — the test is red against the *fixed* framing without the §6.1 key change, which
   is the regression it exists to catch. *Catches: ESC sanitization added without the
   matching key normalization.*

**GREEN invariants — must stay green, and must NOT be presented as proof of the fix:**

4c. **Split-transcript retirement.** Both arms are already green today. The scratch repro
   at `mobile-native-chat-multiline-send.repro.test.ts:49-64` covers only the two-turn pin;
   the one-turn retirement follows from the count pass at
   `mobile-native-chat-pending-retirement.ts:141-167`. **The invariant test must assert both
   arms explicitly** — neither is currently pinned by a test. Corrected in round 4 (round 2
   wrongly moved this under RED) and again in round 5. It is a real invariant worth pinning (it is what makes §6.1's claim that the
   fix retires rather than pins true), but the *behaviour change* is proven by tests 1-3 at
   the wire, not here.

5. **The `'\r'` submit key is never framed** — `typeMobileNativeChatCommandWithOutcome`
   writes one unframed character per RPC and its trailing `'\r'` goes out bare (D3). This
   is the regression guard for the defect review round 1 caught; it must name the `'\r'`
   key explicitly, not just assert "single-line is unframed".
6. **Paced ask answers are never framed** — `ASK_ENTER` groups and the non-stepping
   `formatAskAnswer` branch keep their current bytes, because neither opts in (D3, §7).
7. **All five non-opted-in callers** from the D3 table are byte-identical to today,
   asserted through the public function rather than by inspecting the flag. This must
   include the ask-cancellation Escape (`use-mobile-native-chat-cancel-ask.ts:27`) and the
   permission responses (`mobile-native-chat-permission-send.ts:20`), not only the
   command and answer paths.
8. Single-line opted-in sends are byte-identical to today — no frame, no normalization.
9. Desktop `native-chat-send.test.ts` and the existing bracketed-paste tests pass
   unchanged after the re-export extraction (D1). With re-exports, no desktop import moves,
   so this is a strong signal rather than a rewritten-test signal.
10. `>16 KiB` multi-line draft — the frame survives chunking (§8.1).
11. `ai-vault-resume-launch` still sends an unframed shell command.

**Mutation check.** Each of these must turn a *distinct* test red: remove the frame (1);
remove the line-ending normalization (2); move `\x15` inside the frame (3); remove the
§6.1 ESC key normalization (4b); make framing unconditional instead of opt-in (5, 6, 7);
drop the multi-line condition (8). A single test covering several of these is not
sufficient.

12. **A multi-line insert-only quick command stays unframed and byte-identical**
    (`appendEnter === false`, `enter: false`, `initialPrompt` carrying a shell command).
    This is the guard for the overloaded-seam hazard in §7; without it PR 2 can silently
    frame a shell command. Add it in PR 1 even though the seam is PR 2's, so the guard
    exists before the code that could break it.
13. **Near-ceiling growth — policy stated, tested at the enforcement layer.** Corrected in
    round 4: the 16 MiB limit is enforced host-side
    (`rpc/methods/terminal.ts:299-306`) and chunking happens host-side
    (`src/shared/terminal-input.ts:64-84`), so neither is reachable from a mobile RPC mock.
    **Policy: framed growth is allowed to be rejected by the host.** Mobile reserves no
    client-side headroom, because the ceiling is 16 MiB, a composer draft is kilobytes, and
    a silent client-side truncation would be worse than an honest rejection. The test for
    this belongs in the **host** suite under `config/vitest.config.ts`, asserting the exact
    bytes and the reject outcome at the real enforcement point. Test 10's chunking
    assertion moves to the same layer for the same reason.

PR 2 adds the same RED/GREEN pair per prose launch path: the `initialPrompt` send **from
the diff-review caller only**, the diff-review existing-terminal send, and
`createTerminalAndSendPrompt` — the last asserted through **both** its consumers (PR
triage and commit-failure recovery).

**Not covered by CI:** `tests/e2e/cross-version-wire/` explicitly excludes mobile/E2EE
framing, so it will not exercise this. The compatibility argument in §3 is a reasoning
obligation, not something the harness checks.

**Mobile QA:** must go through `orca emulator` per the mobile QA protocol. The manual
case is: type a two-line message in native chat on a paired device, send, and confirm
the agent records **one** user turn and the phone renders **one** bubble.

## 10. Open questions for review

1. §7 — is the PR split right, or should all three call sites land together?
2. §4/D2 — is unconditional framing right for opted-in prose, or should it be mode-gated
   despite the stale-signal risk?
3. §7 — the non-stepping ask branch (`use-mobile-native-chat-answer-send.ts:258`) has the
   same defect today. Deliberately excluded here. Is that the right call, or should it be
   in scope?

Resolved in round 1: the Windows/ConPTY deferral (§8.2, settled by desktop parity) and
the extraction shape (§4/D1, settled by re-exports).

## 11. Review log

**Round 1 — Fable 5, CHANGES REQUIRED.** Findings accepted and each independently
re-verified against the source before revising:

- **MAJOR** — the original `/[\r\n]/`-only gate would have framed the bare `'\r'` submit
  key used by Codex slash commands and every paced ask answer, breaking both. Fixed by
  making framing an explicit opt-in (D3). This was the plan's one genuine defect.
- **MEDIUM** — §7's answer-send row was wrong: the non-stepping `formatAskAnswer` branch
  has the same defect today and would have started framing silently. §7 corrected, and the
  opt-in makes silent change structurally impossible.
- **MEDIUM** — §9 tests 3 and 4 were invariants that already pass, and the
  remove-normalization mutation had no distinct catcher. §9 rewritten.
- **MINOR** — three unaffected write paths were missing from §7. Added.
- Confirmed sound: §3 wire compatibility (with two strengthening facts now folded in),
  client-side ownership, D1/D4/D5/D6, and the §7 PR split.

**Round 2 — Codex 5.6 Sol (fresh agent, high effort), CHANGES REQUIRED.** Both MAJOR
findings independently re-verified against the source before revising:

- **MAJOR** — §7 missed a fourth prose path: the `initialPrompt` send at
  `[worktreeId].tsx:3754-3762`, reached by the diff-review "send notes to a NEW agent"
  action with `formatDiffComments` output (`'\n\n'`-joined). Also `createTerminalAndSendPrompt`
  has two consumers, not one. §7 corrected; PR 2 must re-derive the inventory by grep.
- **MAJOR** — §6's "creates no new pin" promise was **false**. ESC sanitization
  (raw ESC → U+241B) versus a pending key that keeps raw ESC produces a permanently
  pinned bubble for any multi-line draft containing ESC — reachable by pasting terminal
  scrollback. New §6.1 makes the reconciliation key ESC-equivalent, in scope for this PR
  because without it the framing change regresses. Round 1 saw this and rated it LOW;
  round 2 was right to elevate it.
- **MEDIUM** — D3's "every other caller unchanged" guarantee was asserted, not
  enumerated. All six call sites now tabulated, and §9 extends byte-identity assertions to
  the Escape and permission sequences.
- Confirmed sound with independent file:line evidence: §3 wire compatibility and Rule 3
  classification, the opt-in design being better than a predicate gate, CR/LF equivalence
  under the existing normalizer, §8 SSH/relay/folder convergence and the submit-delay
  deferral, §5's reading of both historical commits, and that the listed RED tests would
  genuinely fail first.

Round 2 was not clean. A fresh Codex agent is required for round 3.

**Round 3 — Codex 5.6 Sol (fresh agent, high effort), CHANGES REQUIRED.** All three
findings re-verified against source before revising:

- **MAJOR** — `initialPrompt` is overloaded. The same seam also carries insert-only
  **shell** quick commands (`quick-commands.ts:66-72`, `enter: false`, possibly
  multi-line), so PR 2 framing on the seam's identity would corrupt them. §7 now carries
  an explicit warning that the opt-in belongs to the diff-review caller, and §9 test 12
  guards it from PR 1 onward. The reviewer's complete grep found **no fifth agent-prose
  caller**, which closes the §7 inventory question.
- **MEDIUM** — §3's size accounting was wrong: ESC → U+241B turns 1 byte into 3, so the
  payload can *grow* by two bytes per ESC, not only shrink. Corrected, with a near-limit
  test (§9 test 13).
- **MEDIUM** — the Rule 3 label was overstated. The document defines Rule 3 as changing
  what the *host* publishes; this is client→host. Relabelled as a client-to-host analogue;
  the byte-pipe conclusion and the no-negotiation outcome are unchanged.
- Confirmed sound with independent evidence: **§6.1's pin claim is real and its fix
  sufficient and symmetric**, with every consumer of the shared normalizer enumerated
  (mobile reconcile plus the renderer's pending-occurrence module) and none broken; the D3
  six-caller table is complete; the wire trace; test 4b is coherent and constructible; §5
  does not repeat the reverted persisted state; §8's convergence and deferral; and the §2
  precedent claims are consistent with visible code and not invented.

Round 3 was not clean. A fresh Codex agent is required for round 4.

**Round 4 — Codex 5.6 Sol (fresh agent, high effort), CHANGES REQUIRED.** Both findings
are specification gaps rather than wrong decisions, and both were verified before revising:

- **Finding 1** — all three PR 2 prose paths call `client.sendRequest('terminal.send', …)`
  **directly** (`use-mobile-diff-review-send-actions.ts:83`, `pr-ai-triage-launch.ts:31`,
  `[worktreeId].tsx:3756`), so the D3 transport seam never reaches them and the plan never
  said how PR 2 would apply framing. D3 now states that the shared module exports a **pure
  function** applied at each prose call site, with the transport argument being one wrapper
  over it, and that framing must never attach to the overloaded `initialPrompt` seam.
- **Finding 2** — §9 test 4 was mislabelled RED: both arms are already green today
  (`mobile-native-chat-pending-retirement.ts:141-167`, demonstrated by the scratch repro).
  Round 2 moved it under RED in error. It is now a GREEN invariant (4c), explicitly not
  offered as proof of the fix. Tests 13 and 10 also asserted host-side behaviour from a
  mobile mock; the near-limit policy is now stated explicitly (framed growth may be
  rejected; no client headroom) and both tests move to the host suite at the real
  enforcement and chunking layers.
- Confirmed sound: the defect trace; §3's corrected arithmetic **and** the client-to-host
  Rule 3 relabelling; §6.1's ESC analysis and shared-normalizer fix, with every consumer
  checked; D3's six-caller classification; an independent inventory finding **no missing
  fifth prose path**; §5 against both commits; §8's SSH/relay/folder and Windows-delay
  reasoning; and the §2 precedent discussion relying on no invented behaviour.

Round 4 was not clean. A fresh Codex agent is required for round 5.

**Round 5 — Codex 5.6 Sol (fresh agent, high effort): CLEAN.** No findings. It
independently re-derived the PTY inventory (`rg -n "terminal\.send" mobile/src mobile/app`)
and confirmed §7's classification; confirmed D3 is now implementable without framing
slash-command keys, selector answers, cancellation, permission bytes, or insert-only shell
commands; confirmed the 4c reclassification and the test-13 host-layer policy; confirmed
§3's accounting, the client-to-host analogue, and client ownership; confirmed §6.1's ESC
fix across every consumer; confirmed D1/D2/D4-D6; confirmed §5 against both commits; and
confirmed §2's precedent needs no unverifiable external behaviour.

Three non-blocking notes, all addressed:
- §9.4c overstated what the scratch repro covers (it pins only the two-turn arm). Corrected,
  and the invariant test now explicitly requires both arms.
- §7's "every path" wording versus the standalone image-attachment row — the row stays in the
  implementation checklist.
- It read §5's two `trimEnd` facts as in tension. They are not; both are now cited with the
  exact commands that verify them.

**Status: plan approved by review. Ready to implement.**
