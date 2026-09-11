# Antigravity readiness: what the transcripts show

`findAntigravityReadyPromptIndex` in `src/main/runtime/terminal-wait-detection.ts` decides whether
an Antigravity pane is ready for a prompt. It has been written five times, each version tuned
against a five-line screen typed from memory into a `.spec.ts` fixture. Three of the first four
were found worse than the bug they replaced, and the fifth was reverted.

Real transcripts now exist. They were recorded from a live `agy` on macOS with
[`agent-pty-transcript-capture.md`](./agent-pty-transcript-capture.md) and are committed under
`src/main/runtime/__fixtures__/`. `src/main/runtime/antigravity-readiness-transcripts.test.ts`
replays them through the runtime.

**Headline: on real output the current detector is inverted.** It refuses a genuinely ready screen
and accepts a live model picker. The five attempts argued about which extra condition to add; none
of them had noticed that the condition they all shared — a line beginning with the model name —
never matches a real Antigravity ready screen at all.

## Versions

| Thing                     | Value                         |
| ------------------------- | ----------------------------- |
| `agy --version`           | `1.1.25`                      |
| Banner printed by the TUI | `Antigravity CLI 1.2.0`       |
| Captured                  | 2026-09-10, macOS, 120x40 PTY |

The binary and its own banner disagree. Any rule keyed to a version string must read the banner,
not `--version`, and must tolerate the two disagreeing.

## What the captures are

| Fixture                                      | What it is                                               |
| -------------------------------------------- | -------------------------------------------------------- |
| `antigravity-ready-api-key-gemini-model.txt` | Ready screen, API-key identity, Gemini 3.7 Flash (Low)   |
| `antigravity-ready-account-info-hidden.txt`  | The same ready screen with `AGY_CLI_HIDE_ACCOUNT_INFO=1` |
| `antigravity-dialog-trust-workspace.txt`     | Workspace trust dialog, live and unanswered              |
| `antigravity-dialog-model-picker.txt`        | `/model` picker, live and unanswered                     |
| `antigravity-dialog-command-palette.txt`     | Slash-command palette, live and unanswered               |
| `antigravity-dialog-dismissed.txt`           | `/model` picker dismissed with esc, then settled         |

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
| X3  | Does the caret survive in the tail?                        | **Yes** — a bare `>` line is present in every ready capture                                                                     |
| X4  | Banner-to-caret distance                                   | ~8 derived lines on a 120x40 PTY; the banner falls outside the 6-line preview window, so only the full retained tail can see it |
| X5  | Pane title on the trust screen versus ready                | Identical: none                                                                                                                 |

## Can attempt six be written?

Yes — but not as a variation on any of the five. Every one of them refined a predicate over
`\n`-delimited lines, and that is the layer where the evidence says the information is not.

What the captures support:

- **The one stable, dialog-free ready marker is a line whose entire trimmed content is `>`.** It is
  present in every ready capture and absent from every dialog capture, because a dialog's `>` always
  carries its selected row's label. This is a much narrower rule than any attempt used, and it is
  the only one that survived contact with the transcripts.
- **Drop the model-row requirement.** It matches dialogs and not ready screens. Keeping it inverted
  the detector.
- **Do not require an account row.** It is optional by environment variable and carries no email for
  API-key users.
- **Do not anchor on `headerIndex`.** The banner is printed once and never reprinted.
- **The blocked-signal path already works** for the trust dialog: `antigravity-dialog-trust-workspace.txt`
  is correctly refused today, by wording, not by structure.

What is still unknown and should be captured before shipping: the sign-in, theme, privacy and
update dialogs, and any ready screen where the composer is not idle (accept-edits and plan mode,
which PRs #15840 and #15852 describe from a screenshot). A bare-`>` rule is only as good as the
claim that those modes still end on a bare `>`; that claim is untested.

The honest summary is that this is a screen-shaped problem being solved with line-shaped tools. A
rule over the derived tail can be made much better than what ships today, but the durable fix is to
ask the terminal emulator what the bottom row of the screen actually is, rather than inferring it
from a byte stream that was written with cursor addressing.
