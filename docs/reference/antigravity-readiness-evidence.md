# Antigravity readiness: what the transcripts show

`findAntigravityReadyPromptIndex` in `src/main/runtime/terminal-wait-detection.ts` decides whether
an Antigravity pane is ready for a prompt. It has been written five times, each version tuned
against a five-line screen typed from memory into a `.spec.ts` fixture. Three of the first four
were found worse than the bug they replaced, and the fifth was reverted.

Real transcripts now exist. They were recorded from a live `agy` on macOS with
[`agent-pty-transcript-capture.md`](./agent-pty-transcript-capture.md) and are committed under
`src/main/runtime/__fixtures__/`. `src/main/runtime/antigravity-readiness-transcripts.test.ts`
replays them through the runtime.

**Headline: on real output the first five detectors were inverted.** They refused a genuinely ready
screen and accepted a live model picker. All five argued about which extra condition to add; none
had noticed that the condition they all shared — a line beginning with the model name — never
matches a real Antigravity ready screen at all.

Attempt six, described in the last section, reads none of the identity, model or banner text. It
asks only where the caret row sits relative to the composer's rule and to the end of the tail.

## Versions

| Thing                     | Value                         |
| ------------------------- | ----------------------------- |
| `agy --version`           | `1.1.25`                      |
| Banner printed by the TUI | `Antigravity CLI 1.2.0`       |
| Captured                  | 2026-09-10, macOS, 120x40 PTY |

The binary and its own banner disagree. Any rule keyed to a version string must read the banner,
not `--version`, and must tolerate the two disagreeing.

## What the captures are

| Fixture                                      | What it is                                                |
| -------------------------------------------- | --------------------------------------------------------- |
| `antigravity-ready-api-key-gemini-model.txt` | Ready screen, API-key identity, Gemini 3.7 Flash (Low)    |
| `antigravity-ready-account-info-hidden.txt`  | The same ready screen with `AGY_CLI_HIDE_ACCOUNT_INFO=1`  |
| `antigravity-dialog-trust-workspace.txt`     | Workspace trust dialog, live and unanswered               |
| `antigravity-dialog-model-picker.txt`        | `/model` picker, live and unanswered                      |
| `antigravity-dialog-command-palette.txt`     | Slash-command palette, live and unanswered                |
| `antigravity-dialog-dismissed.txt`           | `/model` picker dismissed with esc, then settled          |
| `antigravity-busy-mid-turn.txt`              | A real turn, recording stopped while the spinner was live |
| `antigravity-busy-turn-ended.txt`            | The same turn after it ended and the composer returned    |

## What could not be captured, and why

Nothing below was faked. Each is a case the recorder could not reach without changing the
operator's account state or configuration, which is out of bounds.

| Missing                                     | Why                                                                                                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `antigravity-ready-business-non-gemini.txt` | This machine has no OAuth session — the CLI prints _"You are currently not signed in"_ and authenticates from `GEMINI_API_KEY`. Reaching a Business ready screen means signing someone in. |
| A non-Gemini model on any ready screen      | `agy models` offers 11 models, all Gemini, and `settings.json` pins `modelProvider: gemini`. A non-Gemini row is not reachable from this account.                                          |
| `antigravity-dialog-sign-in.txt`            | Unsetting `GEMINI_API_KEY` does not reach the sign-in dialog; the CLI refuses to start because `modelProvider` is pinned. Reaching it means editing the operator's `settings.json`.        |
| `antigravity-dialog-theme-picker.txt`       | There is no `/theme` command in 1.2.0 (`Unknown command: /theme`). The picker appears only in first-run onboarding, which means deleting the operator's config.                            |
| `antigravity-dialog-privacy-notice.txt`     | First-run onboarding, as above.                                                                                                                                                            |
| `antigravity-dialog-update-banner.txt`      | Cannot be forced; no update was pending during the session.                                                                                                                                |

Each remains as a named, skipping case in the suite so it is visible rather than forgotten.

### Still needed — the two open questions on this surface

Both are about the busy lane, and both are the reason a rule was deliberately **not** written. Each
is a capture the recorder could take, not a case it is barred from reaching.

| Still needed                                      | What it would settle                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A successful turn completion**                  | This account's key cannot produce one — every turn ends `Agent execution terminated due to error`, which is what `antigravity-busy-turn-ended.txt` records. So it is unknown whether a finished, successful turn returns the composer to the bottom of the tail (→ reads ready) or leaves result text below it the way the error block does (→ wedges until the next repaint). **Both are consistent with every capture we have.** |
| **A capture ending _inside_ the residual window** | Recording stopped between a frame park and the next spinner tick, so the transcript's own last row is the bare caret with the spinner still live above it. That would fix the line bound for a busy rule **empirically**, which is the only thing missing (§9). Without it, any "read the last N lines" rule is a guess about N, and guessing is what produced attempts one through five.                                          |

## What the transcripts show

### 1. The ready screen's model row is not at the start of a line

The ready screen prints a block-glyph logo down the left, and the identity, model and path rows are
painted **on the same physical lines as the logo**. What Orca derives is:

```
▀▀▀▀▀▀       Gemini API key
▀▀▀▀▀▀▀▀      Gemini 3.7 Flash (Low)
▄▀▀    ▀▀▄     ~
```

The detector requires `normalized.startsWith('gemini', trimmedStart)` on a trimmed line. The
trimmed line starts with `▀`. It never matches. Measured three ways on the real screen:

| Input                                                  | `isKnownReadyPromptPreview` |
| ------------------------------------------------------ | --------------------------- |
| Real ready screen                                      | `false`                     |
| The same screen with the logo glyphs stripped          | `true`                      |
| Real ready screen followed by the live `/model` picker | `true`                      |

So the logo — decoration, and suppressible with `AGY_CLI_HIDE_LOGO` — is what decides readiness
today, and the live dialog is what supplies the model line the ready screen could not.

### 2. The dialog is what satisfies the model rule

`/model` prints its options one per line:

```
Gemini 3.8 Flash
> Gemini 3.7 Flash (current)
Gemini 3.1 Pro
```

Those lines _do_ begin with `Gemini`, and a bare `>` composer line sits earlier in the same tail
from before the picker opened. Both halves of the rule are satisfied **while a dialog owns the
screen**, and the pane reads ready. This is the false-ready hazard the last three attempts were
each trying to close, reproduced from a real capture.

### 3. `>` is the dialog selection marker, not only the composer caret

Every dialog uses `>` to mark the highlighted row: `> Yes, I trust this folder`,
`> Gemini 3.7 Flash (current)`, `> /add-dir`. The idle composer is a line whose whole trimmed
content is `>`. That distinction is the only thing separating them, which means the relaxation
proposed in PRs #15840 and #15852 — accept any line _beginning_ with `>` — would make the trust
dialog and the model picker read as ready. On 1.2.0 the idle composer is a bare `>`; those PRs'
1.1.17 mode-banner claim could not be reproduced here and may be mode-specific.

**A bare `>` on its own is not sufficient either, and an earlier draft of this document was wrong
to say it was.** `/model` is drawn in place _below_ the composer, so the empty composer's own bare
`>` is still on the screen — and still in the derived tail — while the picker owns it:

```
────────────────────────── (120 cols)
>                            ← the composer, idle and bare, under a live dialog
Switch Model
  Gemini 3.8 Flash
> Gemini 3.7 Flash (current)
```

Presence of a bare `>` anywhere in the tail is therefore satisfied by
`antigravity-dialog-model-picker.txt`. What separates the two is **position**: on a ready screen
nothing follows the caret row, and on every in-place dialog the dialog's rows do.

### 4. There is no email account row, and the row can be switched off entirely

For an API-key user the identity row reads literally `Gemini API key`. There is no `@`, no
domain, nothing an account-row rule can key on. Separately, `AGY_CLI_HIDE_ACCOUNT_INFO=1` — a
supported environment variable in the binary — removes the row from a fully ready screen, which
`antigravity-ready-account-info-hidden.txt` captures.

### 5. Dialogs are drawn two different ways, and the banner is never reprinted

The trust dialog and the sign-in splash take the **alternate screen** (`ESC[?1049h` … `ESC[?1049l`).
The model picker and command palette are drawn **in place on the main screen** with erase-to-EOL.
After dismissal the CLI prints `⎿ Exited /model command` and redraws the composer — it does **not**
reprint the banner. The header stays where it was at startup.

### 6. Rows are positioned with cursor addressing, not newlines

The status row is written with absolute and relative moves (`ESC[13;99H`, `ESC[83X ESC[83C`), so
`? for shortcuts` and `Gemini 3.7 Flash · low` end up on one derived line. Any rule that assumes
one screen row equals one `\n`-delimited line is reading a different document than the user sees.

### 7. The composer is a framed box, and dialogs are drawn under it

Replaying each transcript through the main-process headless emulator at the grid it was recorded
on (120x40, from the `.meta.json`) gives the screen the operator saw. Every main-screen capture
has the same bottom structure:

| Fixture               | rule                 | caret row | rule | what follows                       |
| --------------------- | -------------------- | --------- | ---- | ---------------------------------- |
| ready, API key        | `─`x120              | `>`       | ✓    | status row only                    |
| ready, account hidden | `─`x120              | `>`       | ✓    | status row only                    |
| dismissed `/model`    | `─`x120              | `>`       | ✓    | status row only                    |
| `/model` picker       | `─`x120              | `>`       | ✓    | 9 dialog rows, then the status row |
| command palette       | `─`x120              | `> /`     | ✓    | 7 dialog rows, then the status row |
| trust dialog          | — (alternate screen) | —         | —    | —                                  |

So on the screen the discriminator is "the composer box is the bottom structure", and on the
derived tail — which keeps the opening rule and the caret row but loses the closing rule and the
cursor-addressed status row — the same fact reads as **"the last line with content is a bare `>`,
and the line above it is the composer's rule."** That is the rule attempt six ships.

### 8. The first six transcripts end with the CLI tearing itself down — and that marker is a trap

The original recorder had to stop `agy` to end each capture, and `agy` restores the terminal on the
way out. All six of those fixtures end with `ESC[>4m ESC[=0;1u` (keyboard-mode restore) followed by
cursor moves and `ESC[J`, or `ESC[?1049l`, and `antigravity-dialog-dismissed.txt` also prints a
`Resume with -c (or command below):` footer.

Those bytes are not a screen Orca's detector ever sees on a pane it is waiting on, and they erase
rows the screen is being judged on — the ready fixture's own status row does not survive them. So
the replay cuts them. **Which sequence marks the cut is not obvious, and the first choice was
wrong.**

`ESC[>4m ESC[=0;1u` appears exactly once, at the end, in all six of the original captures — which
makes it look like a shutdown marker. It is not one. `agy` emits the same pair when it **enters**
raw mode, and the two later captures show it plainly:

| Capture                                               | `ESC[>4m ESC[=0;1u` offsets | `ESC[?2004l` offsets |
| ----------------------------------------------------- | --------------------------- | -------------------- |
| `antigravity-busy-mid-turn.txt` (5057 B)              | `[18, 1320]`                | none                 |
| `antigravity-busy-turn-ended.txt` (5133 B)            | none                        | none                 |
| `antigravity-ready-api-key-gemini-model.txt` (2192 B) | `[2161]`                    | `[2179]`             |

Cutting at its last occurrence discarded 3.7 KB of `antigravity-busy-mid-turn.txt` — the entire
turn — leaving a replay of the failed first launch, whose tail reads
`Press ctrl+c or ctrl+d twice to exit.` And a guard asserting "the marker is present" fails outright
on `antigravity-busy-turn-ended.txt`, which does not contain the pair at all.

**The generalisable lesson, which matters more than the specific bytes: a six-file fixture set can
make a coincidence look like a rule.** The marker appeared once, terminally, in every file
available at the time, and nothing in that set could have contradicted it. Two more captures did.

The marker is now `ESC[?2004l` (bracketed paste off), emitted once on exit in each of the six
shutdown-inclusive captures and never in the two taken with the fixed recorder. The guard is
inverted to the invariant that holds for both recorders and cannot silently no-op: **the replayed
bytes must not contain the shutdown marker**, and the replay length must equal the marker offset,
or the whole file when the marker is absent. The full bytes are replayed in one extra case, which
pins that a pane whose `agy` has already exited is refused.

### 9. Busy frames park the caret exactly like idle frames — the spinner is what differs

The frame that ends a turn-in-progress and the frame that ends an idle screen park the cursor with
the **same bytes**. Only the hint row differs, and the park erases it:

```
idle:  ? for shortcuts ESC[83X ESC[83C Gemini 3.7 Flash · low  CR ESC[2A ESC[2C ESC[?25h
busy:  esc to cancel   ESC[85X ESC[85C Gemini 3.7 Flash · low  CR ESC[2A ESC[2C ESC[?25h
```

So a rule that keys on "the caret is the last thing in the tail" cannot tell busy from idle **on the
frame alone**. What saves it is what comes next. Each spinner tick is its own repaint with its own
park, two rows higher than the frame's:

```
ESC[?25l CR ESC[2A ⣯  Generating    ESC[11D ESC[?25h
ESC[?25l CR ESC[2A ⣟  Generating.   ESC[12D ESC[?25h
```

That second `CR ESC[2A` splices the composer row away, so the retained tail during a live turn ends
on the spinner row, not on the caret. Measured on `antigravity-busy-mid-turn.txt`:

| Capture                                      | last retained line | bare `>` line present |
| -------------------------------------------- | ------------------ | --------------------- |
| `antigravity-ready-api-key-gemini-model.txt` | `>`                | **yes**               |
| `antigravity-busy-mid-turn.txt`              | `⣟  Generating...` | **no**                |

**Consequence for a caret-based rule:** it already answers "not ready" for a real mid-turn capture,
because there is no bare caret in the tail to match. A constructed input that keeps the park bytes
and only edits the status text is not faithful to a live turn — a live turn has a spinner row
repainting _below_ the composer.

**The residual window, and the clause it implies.** Between a frame park and the next spinner tick
the tail does end on the bare caret and is indistinguishable from idle. The gap is one tick
interval. Any readiness path gated on sustained quiescence is safe, because ticks keep arriving and
the pane is never quiet; a path that only inspects retained text is not. For those paths the
evidence supports one clause, and only one:

> **A braille glyph (U+2800–U+28FF) on the last visible line of the retained tail means working.**

That predicate already exists in this file for cursor-agent (`CURSOR_BUSY_SPINNER_RE`) and should be
reused rather than reinvented. It must be scoped to the **last visible line**, not the whole tail:
`antigravity-busy-mid-turn.txt` prints `⣾  Signing in...` during its failed first launch, which a
whole-tail scan would read as working forever.

Nothing else in the capture distinguishes the two states. The hint row (`esc to cancel` versus
`? for shortcuts`) is erased by the park in both cases, the park offsets are identical, and
`ESC[?25l`/`ESC[?25h` fencing appears around every repaint, idle or busy.

#### …but that clause, implemented, is dead code — and does not close the residual

Implemented as written and mutation-checked, the clause changes no verdict, and **reverting it
fails to make any test fail**. It is subsumed by the caret rule:

- The caret rule requires the last visible line to **trim to exactly `>`**. Trimming strips only
  codes 32 and 9–13, and no braille codepoint is in that set, so a braille glyph on that line
  always survives to make the trimmed span longer than one character. Braille on the last visible
  line therefore implies the caret rule has already returned `null`.
- And in the residual window it is meant to close, the last visible line **is** the bare caret and
  carries no braille, so the clause never fires there. A tail of
  `banner / rule / "> …prompt" / "⣟  Generating..." / rule / ">"` still reads ready with the
  clause present.

So the residual is real but this clause is not its fix. Closing it by text alone requires reading
**more than the last line**, and the bound for that is unpinned — the `Signing in` row above is
exactly why an unbounded scan is unsafe, and no capture ends in the residual window to calibrate
against. Attempt six therefore pins the gap as a failing-when-fixed test
(`KNOWN GAP: the window between a frame park and the next tick still reads ready`) rather than
shipping a clause that cannot reach it.

**Decision: the gap stays pinned and open.** Not because it does not matter, but because closing it
by text alone means picking a line bound that no capture calibrates, and a rule without a fixture
behind it is the thing this whole document exists to stop. The exposure is one inter-tick interval,
visible only to text-only callers; and the `⣾  Signing in...` row proves a whole-tail rule would be
actively wrong rather than merely unproven. The capture that would close it is listed under
[Still needed](#still-needed--the-two-open-questions-on-this-surface).

Callers gated on sustained quiescence are unaffected in any case: spinner ticks keep arriving, so
the pane is never quiet.

## Confirmed / refuted, by attempt

Evidence column names the fixture; all quoted text is from the committed transcripts.

### Attempt 1 — the rule at HEAD

| #    | Claim                                                    | Verdict                     | Evidence                                                                                                                                                 |
| ---- | -------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1  | A ready screen prints the banner `Antigravity CLI`       | **Confirmed**               | `Antigravity CLI 1.2.0` in both ready fixtures                                                                                                           |
| 1.1b | …and its last occurrence in the tail is the live one     | **Refuted**                 | The trust dialog's own body says _"Antigravity CLI requires permission to read, edit, and execute files here"_, so `lastIndexOf` lands inside the dialog |
| 1.2  | The model row begins with the vendor word `Gemini`       | **Refuted**                 | `▀▀▀▀▀▀▀▀      Gemini 3.7 Flash (Low)` — the logo precedes it; never at line start                                                                       |
| 1.3  | The caret line's whole trimmed content is `>`            | **Confirmed** on 1.2.0 idle | bare `>` in both ready fixtures                                                                                                                          |
| 1.3b | …and only the composer prints `>`                        | **Refuted**                 | `> Yes, I trust this folder`, `> Gemini 3.7 Flash (current)`, `> /add-dir`                                                                               |
| 1.4  | A ready screen prints the workspace path on its own line | **Refuted**                 | the path shares its line with logo glyphs (`▄▀▀    ▀▀▄     ~`)                                                                                           |

### Attempt 2 (loop 1) — blacklist the model line

| #   | Claim                                      | Verdict     | Evidence                                                                                                         |
| --- | ------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| 2.1 | Dialog model-row wording is enumerable     | **Refuted** | the palette lists 50+ commands with free-form descriptions; the picker prints whatever models the account offers |
| 2.2 | A dialog never reproduces a real model row | **Refuted** | the `/model` picker prints four real model rows, one per line, at line start                                     |

### Attempt 3 (loop 2) — structural ordering on `headerIndex`

| #   | Claim                                              | Verdict                            | Evidence                                                                                             |
| --- | -------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 3.1 | A live dialog is printed below the ready chrome    | **Confirmed** for in-place dialogs | picker and palette append below the composer                                                         |
| 3.2 | The banner is reprinted when a dialog is dismissed | **Refuted**                        | `antigravity-dialog-dismissed.txt` shows `⎿ Exited /model command` and a redrawn composer, no banner |
| 3.3 | Antigravity does not use the alternate screen      | **Refuted**                        | `ESC[?1049h` opens the trust dialog and the sign-in splash                                           |
| 3.4 | No full repaint per keystroke                      | **Partly refuted**                 | typing `/mod` repaints the palette region on each keystroke with `ESC[K`                             |

Because of 3.2, `headerIndex` cannot be the anchor: it never advances. Ordering can only be
expressed against the model/caret positions, which is what 1.2 and 1.3b just invalidated.

### Attempt 4 (loop 3) — require a positive account row

| #   | Claim                                                | Verdict                | Evidence                                                                                                                    |
| --- | ---------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 4.1 | Every ready screen prints an account row             | **Refuted, twice**     | API-key identity prints `Gemini API key` (no `@`); `AGY_CLI_HIDE_ACCOUNT_INFO=1` removes the row entirely                   |
| 4.2 | A startup dialog never contains an `@`-and-`.` token | **Not reachable here** | none of the captured dialogs contains one, but the palette shows free-form skill descriptions, which are user-authored text |
| 4.3 | The account row is distinguishable from prose        | **Refuted**            | the row is not a distinct line; it shares one with the logo                                                                 |

### Attempt 5 (PR #19749, reverted) — ordering + account row

| #   | Claim                                                    | Verdict     | Evidence                                                                                                                                                                                           |
| --- | -------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1 | Ordering plus an account row separates ready from dialog | **Refuted** | the account row is optional (4.1) and the ordering anchor never moves (3.2)                                                                                                                        |
| 5.2 | Executing both builds was sufficient verification        | **Refuted** | the executed input was the hand-written fixture, so the check reproduced the fixture's assumptions. The real screen disagrees with that fixture on the model row, the path row and the account row |
| 5.3 | The wedge is a model-name problem                        | **Refuted** | it is a line-start problem. Even `Gemini 3.7 Flash (Low)` — a Gemini model — fails, because a logo glyph precedes it                                                                               |

### Cross-cutting

| #   | Question                                                   | Answer                                                                                                                          |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| X1  | Does `agy` set an OSC title distinguishing busy from idle? | **No.** Not one OSC title sequence appears in any capture. Title-based readiness is unavailable for this agent                  |
| X2  | Does it repaint with bare `\r`?                            | **Yes**, constantly, plus `ESC[K` and absolute cursor moves                                                                     |
| X3  | Does the caret survive in the tail?                        | **Yes** — a bare `>` line is present in every ready capture, and in the `/model` picker's too (§3)                              |
| X4  | Banner-to-caret distance                                   | ~8 derived lines on a 120x40 PTY; the banner falls outside the 6-line preview window, so only the full retained tail can see it |
| X5  | Pane title on the trust screen versus ready                | Identical: none                                                                                                                 |

## Attempt six, and what each of its rules is standing on

`findAntigravityReadyPromptIndex` now has three clauses and nothing else. Each one names the
transcript that forces it.

| Clause                                          | Why                                                                                    | Fixture                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| the tail contains `antigravity cli` _anywhere_  | only a gate, so the rule cannot fire on Codex/Cursor panes                             | both ready fixtures; `lastIndexOf` refuted by the trust dialog's own body text (§1.1b)  |
| the last line with content trims to exactly `>` | dialogs paint their rows under the composer, so the caret stops ending the tail        | ready fixtures end on `>`; picker ends `G`, palette ends `> /`, trust ends its nav hint |
| the line above it is a run of ≥8 `─`            | `>` alone also marks a dialog's selected row, and can end a model's own prose mid-turn | the composer rule is directly above the caret in all three ready-shaped captures        |

Dropped, each because a transcript refuted it: the **model row** (§1 — the logo shares that line,
so it never starts one, and the `/model` picker supplies the rows the ready screen could not), the
**account row** (§4 — `Gemini API key` has no `@`, and `AGY_CLI_HIDE_ACCOUNT_INFO=1` deletes the
row), and the **`headerIndex` anchor** (§5 — the banner is printed once and never reprinted).

The blocked-signal path is left alone: it already refuses `antigravity-dialog-trust-workspace.txt`
on wording, and it is the only thing that names a reason for the refusal.

### What it fails safe on, and how

Four screens could not be captured, plus two composer modes. In every one of them the rule
reports **not ready**, which stalls a `tui-idle` wait rather than typing into a live dialog:

| Unknown                                                | Behaviour                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Business/OAuth ready screen                            | Ready, and correctly so — the rule reads no identity at all, so the account type cannot change the verdict                                       |
| Non-Gemini model row                                   | Ready, same reason: no model text is read                                                                                                        |
| Sign-in dialog                                         | Not ready, _unless_ it happens to end on a rule + bare `>`. Drawn on the alternate screen (§5), which has no composer                            |
| Theme / privacy / update banner                        | Not ready: a banner owning the screen puts rows under the composer                                                                               |
| Accept-edits and plan mode                             | Not ready: PRs #15840/#15852 describe a mode banner on the composer row, which is not a bare `>`. A wedge, not a mis-send                        |
| A live turn (spinner running)                          | **Not ready**, and now capture-backed: `antigravity-busy-mid-turn.txt`'s tail ends on `⣟  Generating...`, with no bare caret anywhere in it (§9) |
| The gap between a frame park and the next spinner tick | **Ready — a real open gap.** One tick wide, unreachable for quiescence-gated callers, pinned as a KNOWN GAP test (§9)                            |
| A turn that has ended                                  | **Not ready** — pinned KNOWN DEFECT. `antigravity-busy-turn-ended.txt`'s tail ends on the error block, not the composer. See below               |

The two that cost a wedge — the mode banners, and any 1.1.x that does not draw the composer box —
are the price of the asymmetry: a false negative stalls one wait, a false positive types a user's
prompt into a live dialog.

### Why this is still not the emulator, and what it would take

The durable fix is to ask an emulator what the bottom of the screen is. That was evaluated first
and is not reachable from the readiness path as it stands:

- `isKnownReadyPromptPreview` is a pure string predicate called from six sites
  (`runtime-terminal-wait`, `runtime-terminal-idle-polls`, `runtime-terminal-agent-presence`,
  `orca-runtime-stop-structured-session-process`, and the visible-read probe), all on the derived
  tail, and most of them synchronously.
- The main process _does_ keep a live per-PTY emulator (`headlessTerminals`, fed by
  `trackHeadlessTerminalData` on every chunk), and `readHeadlessVisibleTerminalState` projects it
  through `projectTerminalVisibleLines`. But the one readiness call site wired to it,
  `startTuiIdleVisibleReadProbe`, only runs when the tail is **empty** — never for an Antigravity
  pane that has printed a banner.
- For PTYs in `providerSnapshotPreferredPtys` (restored panes, and remote sessions where main holds
  only a suffix) the authoritative screen needs a provider RPC, so the emulator is not uniformly
  available and a per-poll screen read is not free.

Moving readiness onto the screen therefore means threading a `ptyId`-or-projection through those
six call sites, giving the idle poll an async hop, and deciding the provider-snapshot lane's
budget — a change to every agent's readiness, not just Antigravity's. Worth doing; too wide to
ride along with a detector fix that has already been wrong five times.

It is worth noting what it would buy, because it is narrower than it sounds: the emulator supplies
a **clean, correctly-ordered screen**, but not a verdict. The predicate above still has to be
written, and against these same six fixtures the screen version ("the composer box is the bottom
structure") and the tail version ("the caret row ends the tail, under its rule") agree on all six.
The one thing only the emulator can add is knowing a pane is on the **alternate screen**, which is
where the trust and sign-in dialogs live — the single unknown this rule cannot reason about.
