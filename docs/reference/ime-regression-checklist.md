# IME Regression Checklist

## Follow-up issue ledger

These reports define durable acceptance contracts, not only the symptoms from
one machine.

| Issue                                                                                                                         | Root cause                                                                                                                                                                                 | Ownership invariant                                                                                                                                                                                                                                                                                                                                             | Required evidence                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [#16911](https://github.com/stablyai/orca/issues/16911) Native Chat preedit overwritten by streaming or attachment settlement | React reconciliation or an asynchronously resolved attachment writes an application draft while the browser owns the composing textarea; duplicate settlement can then re-adopt stale DOM. | From `compositionstart` until the first `compositionend` or blur, the browser owns the textarea. Resolved paths queue at the shared semantic sink; settlement adopts the browser DOM before flushing once.                                                                                                                                                      | Repeated stale streaming rerenders preserve the element and preedit; idle external drafts still synchronize; concurrent SSH completions preserve completion order and duplicates; both settlement orders run once; disable discards queued work; blur does not steal focus; native composition commits once. |
| [#16949](https://github.com/stablyai/orca/issues/16949) terminal preedit has no visible cursor                                | The opaque composition overlay covers the renderer cursor; at the final cell an over-wide inline preedit can also place its caret beyond the clipped screen.                               | The existing xterm `CompositionHelper` owns a visible caret after the preedit and before any row remainder; final-cell composition end-aligns within the screen while mid-line composition stays left-anchored.                                                                                                                                                 | Start, update, arbitrary-width final-cell containment, mid-line remainder placement, cleanup, and update-without-start are covered; preview and normal terminals inherit the live cursor theme.                                                                                                              |
| [#16950](https://github.com/stablyai/orca/issues/16950) typing diagnostic records no CJK samples                              | The probe observes echoing keydowns but not reconciled composition commits, then guesses which queued input owns opaque TUI output.                                                        | A reconciled composition is observed even when `compositionend.data` is empty; only an isolated input enters exact percentiles, while overlap or a dropped-input gap produces one aggregate ambiguous burst.                                                                                                                                                    | Recorded Linux IBus empty-data commit, isolated direct and IME samples, mixed-source ambiguity, timeout/cap gaps, UTF-8 output bytes, and stop/drain cleanup are covered.                                                                                                                                    |
| [#17104](https://github.com/stablyai/orca/issues/17104) Korean preedit repeats the Codex placeholder                          | Generic xterm row-tail reproduction exposed an application-semantic Codex or Claude composer placeholder that presentation style cannot identify safely.                                   | Xterm always preserves generic covered row text. Orca's existing structural composer classifier masks only a verified placeholder during the exact active composition session; repaint reclassification runs only while composing, and end, blur, or disposal clears ownership, class, and listeners. Arbitrary dim output and shell lookalikes remain visible. | Codex prompt/footer and Claude prompt/frame classification, arbitrary all-dim and shell-lookalike negatives, repaint entry and exit, end/blur/disposal cleanup, and rendered Electron proof at cursor column 2 preserving generic row text are covered.                                                      |

## Preedit cell advances (#19315)

Single-codepoint CJK graphemes use the active Unicode provider's cell width and
measured font advance. Ordinary inline spans preserve browser bidi and baseline
layout; equal corrections share a run. Keep glyphs unscaled and the underline,
caret, and candidate textarea aligned with the rendered preedit. Appending ASCII,
emoji, or another script must not change an existing CJK prefix's correction.
Combining sequences, emoji, other scripts, and whitespace retain native shaping.
Font loading, typography changes, and renderer metric changes must update an open
composition; row-tail repaints preserve its unchanged nodes.

Cold font measurements and styled runs share a fixed work budget. Repeated CJK
can remain one corrected run; after the budget is exhausted, the remaining text
keeps its native advance. This deliberately leaves the original spacing mismatch
in the tail of unusually varied long compositions, without switching the prefix
back to native spacing or rebuilding thousands of spans.

`terminal-ime-xterm-preedit-cell-grid.test.ts` covers text preservation, native
clusters, lifecycle, and bounded work. `terminal-ime-preedit-cell-grid.spec.ts`
checks rendered glyph origins, caret/textarea geometry, underlines, font changes,
and native shaping at DPR 1, 1.25, and 2 with WebGL on/off.
`terminal-ime-preedit-continuity.spec.ts` covers mixed suffixes and budget crossings.
These checks use Chromium composition through CDP; they do not replace native OS
IME evidence.

## Bounded-state and ownership contracts

Every transient collection and ownership tracker must have an explicit lifetime and bound:

- Native Chat uses `NATIVE_FILE_DROP_MAX_PATHS` (`256`). If a resolved completion would cross the cap, the whole batch is rejected atomically and the overflow notice remains visible through settlement; accepted paths keep order and duplicates. The queue is cleared before re-entry and on disable or pane-owner remount.
- The terminal placeholder mask tracks one scalar `activeSessionId` because xterm renders one composition view. A newer start supersedes an older one, a stale end cannot clear the latest owner, and blur or disposal clears it. The composition route keeps its per-ID reference-counted map intentionally for transport ownership; it is not replaced by the scalar.
- Typing diagnostics cap pending and ignored echo candidates at `MAX_PENDING_ECHO_CANDIDATES` (`64`), cap pending user-input signals, drain timed-out candidates, and clear all series on pane detach. Overflow becomes an explicitly ambiguous burst rather than an arbitrary attribution.

## Native Chat asynchronous attachment settlement

Attachment resolution is an external semantic write, including local file
selection, pasted-image temp saves, and SSH uploads. While composition is active,
it must not replace the browser-owned textarea value.

- Start two concurrent SSH uploads, resolve the second first, and return one path
  twice. Preserve completion order and both duplicates.
- On the first settlement event, adopt the browser DOM before flushing queued
  paths. Exercise `compositionend` then blur and blur then `compositionend` in
  one React batch; both orders must adopt and flush exactly once.
- If the composer becomes disabled before an upload resolves or before the queue
  flushes, discard that result.
- If `compositionend` is omitted, blur performs the same one-time settlement
  without focusing the textarea or stealing focus back.

## Cross-platform verification

Synthetic DOM events prove Orca's event and rendering contracts, but they do
not exercise the operating system's input method. Changes must also cover:

| Environment | Native evidence                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS       | A native Korean 2-set composition in Native Chat and a terminal; preedit survives external renders, the caret remains visible, and commit occurs once.                               |
| Windows     | Microsoft Korean IME over an untouched Codex placeholder; the preedit is the only visible text, the placeholder returns after cancel, and ordinary mid-line content remains visible. |
| Linux / SSH | IBus Hangul with an SSH-hosted PTY; an empty-data `compositionend` still produces one diagnostic sample and one committed syllable.                                                  |

For remote evidence, `live` means the owning host reported the current
verification session or process identity. `exited` requires positive
host-owned evidence that the same identity terminated or is absent. Any
transport failure, stale identity, timeout, or inability to ask the owning host
makes the result `unverifiable`; it is never evidence that the composition or
PTY process exited.

## Code elegance gate

Each fix must pass all of these checks:

- Reuse the component that already owns the state or overlay; do not install a
  second composition state machine.
- Make browser, renderer, and PTY ownership boundaries explicit. Provisional
  text must not leak into committed state or PTY input.
- Route local selection, pasted-image temp saves, and SSH upload results through
  one resolved-attachment sink; queue semantic paths, never whole draft snapshots.
- Keep correctness changes separate from unrelated micro-optimizations.
- Use bounded per-composition state and work. Dispose every listener, timer,
  observer, and DOM node with its owner.
- Preserve ordinary Latin input, mixed styled terminal content, local and SSH
  PTYs, preview terminals, and folder workspaces with paired negative tests.
- Keep platform quirks behind event contracts or runtime platform checks; do
  not branch on an IME vendor, language, or terminal agent name.
- Treat the canonical xterm source patch as the only hand-edited source, then
  regenerate its bundle patch and lockfile together.
- Prefer deterministic replay or state-transition tests. Native evidence is a
  second layer, never a substitute for regression coverage.

## Enter in application text fields (#25035)

Use `Input`, `Textarea`, or `CommandInput` for styled fields. Existing unstyled
fields with keyboard actions use `ImeInput` / `ImeTextarea` from
`lib/ime-text-field.tsx`; those preserve the DOM element, styles, refs, and
composition callbacks. They share `useImeEnterGestureOwnership` and keep
IME-owned keys out of both field actions and bubbling form/menu shortcuts.
Overlay primitives also reject IME-marked Escape in document capture, where
field-level propagation guards cannot intercept dismissal.
Do not add a second tracker at a call site already using a guarded field.
Native Chat and the File Explorer inline name field retain their existing
trackers because they also own specialized composition or element lifetimes.

Required cases:

- `isComposing`, `keyCode: 229` without `isComposing`, and `Process/229` must
  never submit, choose a suggestion, or dismiss the field.
- The unmarked Enter redispatch stays owned on either side of keyup, including
  a `Process/229` release. A
  subsequent ordinary typing/navigation key ends that carry immediately;
  hidden renderers may defer animation frames, and typing a filename suffix
  must not cause the next deliberate Enter to disappear.
- Composition callbacks, blur, refs, and keyed remount cleanup still work.
  Normal Enter, modifier submits, and Shift+Enter newlines remain available.
- Test the actual shared field when a consumer delegates IME handling to it;
  a mock that replaces `CommandInput` with a raw input removes the protection.

`ime-text-field.test.tsx` covers primitives, raw fields, parent handlers, and
command selection. File Explorer component tests cover all three operations
and input replacement. `file-explorer-ime-enter.spec.ts` drives Chromium
composition in New File, New Folder, and Rename in a folder workspace, then
checks the complete name in the Explorer and on disk, with both continued typing
and a redispatch followed by deliberate Enter. Overlay tests cover IME Escape
and ordinary dismissal; Markdown tests preserve an unmarked save shortcut while
composition state lingers. These are CDP event
contracts, not native OS keyboard evidence.

The audit also covers settings and title fields, issue/review creation and
pickers, comments and annotations, search fields, Native Chat questions,
notebook execution shortcuts, and Markdown menu handlers. Terminal input keeps
its existing xterm/PTY ownership; mobile native fields use `onSubmitEditing`
instead of desktop DOM keydown actions. Remote workspaces use the same renderer
fields; file-operation routing and mixed-version wire contracts are unchanged.
