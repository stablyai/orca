# Remote terminal agent drafts: low-latency editing and second edits

Status: implemented behind capability negotiation. Verified end to end against Pi 1.3.0's real TUI
editor for capture, multi-line middle edits, replacement, conflict invalidation, and clearing the
editor with Enter. Host unit tests cover the three Enter settlements.

## Problem

Two separate defects produced the reported experience:

1. Typing into a remote terminal pays a network round trip per keystroke batch. A local composer
   removes that cost for composing prompts, while direct terminal input stays available for TUIs.
2. The phone's command box only owned its own text. Sending appended at the remote cursor, so an
   existing multi-line draft could not be retrieved, edited in the middle, and put back.

Screen scraping was not an acceptable source of truth. `terminal-composer-draft.ts` recognises a
prompt from visible rows, but it cannot see a hidden paste buffer, the CLI's real cursor, or
whether the agent has already accepted the text.

## Verified capability

Pi 1.3.0 exposes the two calls this design needs from its in-process extension API:

- `ctx.ui.getEditorText()` returns the full editor text (`interactive-mode.js` uses
  `editor.getExpandedText()`, so collapsed large pastes are expanded).
- `ctx.ui.setEditorText(text)` replaces that text.

A real Pi TUI session (isolated `PI_CODING_AGENT_DIR`, isolated session dir, `--offline`) produced
this transcript through the bridge files:

| Step                                                   | Result                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| Capture empty editor                                   | `text: ""`                                                                 |
| Paste `first line\nsecond line\nthird line`            | captured exactly                                                           |
| Replace middle line                                    | applied, capture returns `first line\nsecond line EDITED\nthird line`      |
| Type `X` directly in the TUI, retry with the old token | `conflict`, returns the current text `...third lineX`; nothing overwritten |
| Write a replacement, then send `\r`                    | editor text becomes `""`; the draft was consumed once                      |

The extension is only a bridge to that API. It does not simulate keys or infer text from output.

## Support matrix

| Agent                   | Version          | Capture                                              | Replace | Notes                                                                                           |
| ----------------------- | ---------------- | ---------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| Pi                      | 1.3.0 (verified) | yes                                                  | yes     | Real TUI transcript above.                                                                      |
| OMP                     | not verified     | reports support only if it exposes both editor calls | same    | The extension is installed, but no real OMP session was probed, so this is not a support claim. |
| Prime Agent             | —                | no                                                   | no      | The managed extension set does not include the bridge.                                          |
| Codex / Claude / others | —                | no                                                   | no      | No verified editor read/replace contract in this change. They keep direct terminal input.       |

The capability is bound to the running process, not to an agent name: the bridge directory is
created per PTY, and its random token is passed only to that spawn. A reused PTY id with a new
process gets a new directory/token, so an old editor cannot answer for it.

## Architecture

### In-agent bridge (`orca-draft-bridge.ts`)

Orca installs this extension next to the existing Pi managed extensions. On `session_start` in TUI
mode it writes `hello.json` (protocol, token, pid, session id, capabilities) and polls
`request.json` every 40 ms. It rewrites `hello.json` every 2 s as a heartbeat.

- `capture` returns the exact editor text and an opaque `sourceToken` =
  `pi:v1:<process instance>:<sha256(text)>`.
- `replace` recomputes that token from the current editor text. If it differs from `baseToken`,
  the reply is `conflict` with the current text. Otherwise it calls `setEditorText`, reads the
  editor back, and only reports success when the read-back matches.
- Requests with another process's token are ignored.
- It writes nothing outside TUI mode, so RPC/print sessions cannot accidentally service a pane.

The read-check-write happens on the agent's own event loop, so a keystroke already processed by the
agent changes the token and blocks the replacement.

### Host coordinator

`TerminalDraftCoordinator` keeps, per live PTY:

- an edit lease (`epoch`, client id/type, bridge token, last use), and
- bounded per-operation results for save and submit.

`terminal.draft.begin` returns the real text plus the agent token. A second client gets `locked`
until it explicitly takes over; a takeover increments the epoch and the previous device's save is
rejected as `stale_lease`. The lease expires after five minutes without use.

`terminal.draft.save` writes the whole text and does not press Enter.

`terminal.draft.submit` writes the whole text, then asks the existing runtime send path for a
single Enter write with a write settlement. The answer distinguishes:

- `submitted`: the host accepted the Enter write.
- `saved_not_submitted`: the draft is in the terminal but Enter was refused.
- `submit_unknown`: the draft is in the terminal and the Enter settlement is unknown.

A repeated `operationId` replays the stored answer instead of pressing Enter again. This reduces
obvious retry duplication, but it is not a cross-crash exactly-once promise for generic PTY input.

### Clients

- Desktop: a "Draft" button on remote terminal panes opens a local textarea. Typing is local;
  Save/Reload/Send are explicit. Closing with unsaved text parks a recovery copy, and reopening
  against changed terminal text surfaces a conflict instead of overwriting.
- Mobile: the buffered command bar gets a download action that pulls the terminal draft, a save
  action that writes without Enter, and an Exit action that releases the lease while leaving the
  local text in place. The normal send arrow submits through the draft bridge while a draft
  session is active; otherwise it keeps the existing `terminal.send` path.

Neither client polls the host while typing, and neither changes terminal size/mode to "make room".

## Negotiation and mixed versions

The new RPC methods are additive. An old host answers method-not-found; the mobile operation
policy reads that as `null` and shows "This Orca host doesn't support draft editing yet". An old
client never calls the methods. No client sends a new opcode on the terminal stream. The bridge
extension is installed harmlessly for non-Orca Pi processes (no bridge directory, so it returns
immediately).

## Limits

- Raw SSH provider PTYs are not supported in this version. The bridge directory is host-local and
  is intentionally not injected for WSL; a raw SSH remote shell has no guaranteed path to it.
- Local (non-paired) panes are not included: the renderer addresses remote PTYs by encoded handle,
  while local panes use provider writes. The button is not shown for them.
- Only prompt-composing text is covered. Permission dialogs, menus, `Tab`/arrow navigation, and
  interrupt handling remain direct terminal input.
- A remote physical keyboard can still change the editor between a successful replacement and the
  host's Enter write. The window is milliseconds, but it is not a lock over the CLI buffer.
- If the host loses the operation result, the UI says so. It does not automatically resend the
  prompt or Enter.
- Codex and Claude are not claimed. A future adapter needs its own verified capture/replace
  contract (native API or a real external-editor handoff).

## Performance evidence

The previous baseline experiment measured enqueue-to-dispatch only (no network, PTY, agent, or
rendering): mobile queue median ≈109 ms / max ≈186 ms at a simulated 200 ms acknowledgement;
desktop batcher ≈9 ms. Those numbers still describe the direct path; this change does not remove
direct path acknowledgements.

What changed for composing:

- The draft text lives in the client's normal text control. Keystrokes do not invoke RPC, so the
  local edit path does not add a network round trip at RTT 0/80/200/500 ms.
- Capture and replace are explicit actions. On the probe machine, 40 consecutive replace
  operations (each including the extension's 40 ms poll wait) measured median 44.31 ms,
  P95 47.42 ms, max 48.08 ms. A paired host adds one RPC round trip per action, not one per
  keystroke.

The proposed P95 targets (local edit ≤50 ms; mobile enqueue-to-send ≤20 ms) are **not** claimed as
passed. No instrumented Electron render measurement was taken in this change, and the direct
mobile queue was left unchanged rather than weakening ordering/deduplication guarantees.

## Test evidence

Added tests cover:

- bridge capability gating (wrong token, stale heartbeat, timeout),
- exact capture / middle-line replacement / remote-edit conflict against the file protocol,
- the in-agent extension through a VM harness with a real temporary bridge directory,
- host leases, takeover fencing, operation replay, conflict, and the three submit settlements,
- desktop recovery/conflict resolution and the editor's unsupported/locked/save UI states.

The existing Pi extension installation, host environment assembly, and opencode/pty suites were
rerun after the install and env changes.

## Remaining work

1. Probe OMP and the user's actual installed Pi version on the paired Windows host before adding
   either to the support claim.
2. Observe a real agent turn after Enter on a logged-in Pi (the probe machine had no model, so
   only the editor-consumption side was observed).
3. Add a second adapter (Codex/Claude external-editor handoff) only after its cancel and
   exclusivity semantics are captured from the real CLI.
4. Measure local-edit and real end-to-end latency in hidden Electron/CDP once a renderer harness
   exists for a paired host.
5. Support raw SSH by giving the bridge a transport that does not assume a shared filesystem.
