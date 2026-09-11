# Antigravity readiness: the evidence that is missing

`findAntigravityReadyPromptIndex` in `src/main/runtime/terminal-wait-detection.ts` decides whether
an Antigravity pane is ready for a prompt. It has been written five times. Each version was tuned
against a five-line screen typed from memory into a `.spec.ts` fixture. Three of the first four
were found to be worse than the bug they replaced, and the fifth was reverted after it turned out
to (a) still return `ready=false` for the personal/API-key user it existed to unwedge and
(b) flip all five silent startup dialogs to `ready=true` on a narration line containing `@` and
`.`.

There is no Antigravity transcript in this repository. Every attempt was therefore a guess about
what the CLI prints, tested against another guess. **Do not write a sixth detector before the
captures below exist.** Capture them with
[`agent-pty-transcript-capture.md`](./agent-pty-transcript-capture.md), scrub them, commit them,
and `src/main/runtime/antigravity-readiness-transcripts.test.ts` starts asserting instead of
skipping.

## The four captures

Record each one with the recorder, in a throwaway workspace, on a real Antigravity install.
Note the CLI version and account type in `--note`.

### A — ready screen, Business account, non-Gemini model

`antigravity-ready-business-non-gemini.txt`

Preconditions: signed in with an **Antigravity Business** account; a **non-Gemini** model
selected before the capture (switch with the model picker, then dismiss it, then start a fresh
session so the ready screen is clean); workspace already trusted; no update pending.

Sit at the ready screen, type nothing, stop with <kbd>Ctrl</kbd>+<kbd>]</kbd>.

Answers: does the account row print at all on a ready screen, and does a Business account row
look different from a personal one?

### B — ready screen, personal / API-key account, non-Gemini model — the decisive one

`antigravity-ready-personal-non-gemini.txt`

Preconditions: signed in with a **personal account or a raw API key** (not Business); a
**non-Gemini** model; workspace trusted; no update pending. Otherwise identical to A.

Answers the question the whole exercise turns on: **is there an account row here?** If a
personal/API-key ready screen prints no identifier, then any rule that requires an account row can
never return `ready=true` for this user, and the reported wedge cannot be fixed that way — which
is exactly what the fifth attempt did, unknowingly.

### C — each startup dialog, live, while it owns the screen

| Dialog         | Fixture                                 |
| -------------- | --------------------------------------- |
| Sign-in        | `antigravity-dialog-sign-in.txt`        |
| Model picker   | `antigravity-dialog-model-picker.txt`   |
| Theme picker   | `antigravity-dialog-theme-picker.txt`   |
| Privacy notice | `antigravity-dialog-privacy-notice.txt` |
| Update banner  | `antigravity-dialog-update-banner.txt`  |

Preconditions per dialog: force it to appear (sign out for sign-in; a fresh config directory for
theme and privacy; `/model` for the picker; an installed-but-not-applied update for the banner),
then **stop the capture with <kbd>Ctrl</kbd>+<kbd>]</kbd> while the dialog is still up**. Do not
answer it. A transcript of an answered dialog is capture D, not capture C.

Answers what all five attempts guessed at: what the caret and the surrounding chrome look like
_while a dialog owns the screen_. Specifically — is the banner, model row, account row or caret
still on screen underneath the dialog; does the dialog draw over them; is any of it in the
alternate screen buffer.

### D — a dialog immediately after dismissal

`antigravity-dialog-dismissed.txt`

Preconditions: start the same session as one C capture, answer the dialog, and stop the capture
the moment the CLI settles — before typing a prompt.

Answers whether the ready chrome is **reprinted** after dismissal. That single fact decides
whether readiness may be anchored on `headerIndex` (only correct if the banner is reprinted, so a
dialog above it cannot be mistaken for live chrome) or must be anchored on
`max(modelIndex, caretIndex)` (correct if the banner is printed once and never again).

## Falsifiable questions, by attempt

Each row is a claim some version of the detector assumed. None has ever been checked against a
transcript.

### Attempt 1 — the shipped rule at HEAD

`lastIndexOf('antigravity cli')`, then a line starting with `gemini`, then a line whose whole
trimmed content is `>`.

| #   | Claim                                                                                                           | Confirmed or refuted by                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | A ready screen prints the literal banner `Antigravity CLI`, and its last occurrence in the tail is the live one | A, B, D                                                                                                                           |
| 1.2 | The model row begins with the vendor word `Gemini`                                                              | **A and B** — the CLI is not Gemini-only; this is the reported wedge                                                              |
| 1.3 | The caret line's entire trimmed content is a single `>`                                                         | A, B, D — PRs #15840 and #15852 claim 1.1.17 renders `> Accept-edits mode: …` instead, from a screenshot, never from a transcript |
| 1.4 | A ready screen prints the workspace path on its own line                                                        | A, B                                                                                                                              |

### Attempt 2 (review loop 1) — blacklist the model line

Reject a candidate model row whose text matches known dialog wording.

| #   | Claim                                                                                      | Confirmed or refuted by                                                |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 2.1 | The set of strings that can occupy the model-row position on a dialog screen is enumerable | C — any dialog whose row text is outside the list refutes it           |
| 2.2 | A dialog screen never reproduces a real model row                                          | C, especially the model picker, which prints model names by definition |

### Attempt 3 (review loop 2) — structural ordering on `headerIndex`

Require the ready chrome to appear _after_ the blocked signal, as the Codex and Cursor rules do.

| #   | Claim                                                                                                                                                | Confirmed or refuted by                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 3.1 | A live dialog is printed _below_ the ready chrome, never over it                                                                                     | C                                                                       |
| 3.2 | The banner is reprinted when a dialog is dismissed, so `headerIndex` advances past the dialog                                                        | **D**                                                                   |
| 3.3 | Antigravity does not use the alternate screen buffer for dialogs (if it does, the retained tail keeps pre-dialog content and ordering means nothing) | C, D — needs raw escapes, which is why a pasted screen cannot answer it |
| 3.4 | The CLI does not fully repaint its banner on every keystroke or resize (a repaint moves `lastIndexOf`)                                               | C — type into the composer during one capture                           |

### Attempt 4 (review loop 3) — require a positive account row

Require a line containing `@` and `.` between the banner and the caret.

| #   | Claim                                                                       | Confirmed or refuted by                                                                                      |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 4.1 | Every ready screen prints an account row                                    | **B** — if a personal/API-key screen prints none, this rule can never unwedge the reported user              |
| 4.2 | A startup dialog screen never contains an `@`-and-`.` token                 | C — the revert showed all five dialogs flipping ready on a narration line; confirm which of them narrate one |
| 4.3 | The account row is distinguishable from prose that merely contains an email | A, B, C                                                                                                      |

### Attempt 5 (PR #19749, reverted) — ordering plus account row plus neutral labels

| #   | Claim                                                                    | Confirmed or refuted by                                                                                                    |
| --- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 5.1 | Ordering plus an account row is sufficient to separate ready from dialog | B + C together                                                                                                             |
| 5.2 | Executing both builds is enough verification without a transcript        | Settled: it is not. The executed check used a hand-written screen as its input, so it reproduced the fixture's assumptions |
| 5.3 | The wedge is a model-name problem rather than an account-row problem     | **B**                                                                                                                      |

### Cross-cutting questions, worth answering from the same captures

| #   | Question                                                                                                               | Why it decides the shape of attempt 6                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| X1  | Does Antigravity set an OSC title, and does it distinguish working from idle (as cursor-agent's braille spinner does)? | If yes, readiness may need no text rule at all — `detectExplicitIdleStatusFromTitle` already carries this for four other agents            |
| X2  | Does the CLI repaint with bare `\r` and no `\n`?                                                                       | Orca's tail is line-split; a CR-only repaint collapses the screen into one enormous line and every line-based rule silently stops matching |
| X3  | Does the caret line sit in the tail at all after Orca's tail normalisation, or is it erased by a redraw?               | The caret is the anchor of every attempt so far                                                                                            |
| X4  | How many lines separate the banner from the caret on a real screen?                                                    | The tail window is bounded; a banner outside it is invisible to `lastIndexOf`                                                              |
| X5  | What does the pane title look like on the trust screen versus when ready?                                              | The runtime already uses a live working title as staleness proof for startup modals                                                        |

## What to do with the answers

1. Commit the transcripts (scrubbed) and their sidecars.
2. Run `pnpm test src/main/runtime/antigravity-readiness-transcripts.test.ts`. The cases stop
   skipping. Expect failures: they are the first real measurement of the current rule.
3. Record the answer to every question above in the PR that follows, citing the fixture and line.
4. Only then change `findAntigravityReadyPromptIndex`, and keep the transcripts as the test.
