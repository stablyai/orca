# Agent browser input and the user's keyboard focus

Read this before changing how agent browser commands deliver mouse, key or text input to a
browser page, or before adding a `webContents.focus()` call on a page an agent drives. Background:
issue [#20595](https://github.com/stablyai/orca/issues/20595), with #16674, #12912, #16410, #19297,
#20533, #26338 and #8139.

## The rule

Agent input reaches the page it targets and nothing else. It never moves the user's keyboard focus,
and it never lands in whatever the user is typing into. Only an explicit user-facing focus request
(`tab switch --focus`) may reveal a page, and even that does not hand it OS focus.

## Why `<webview>` makes this hard (measured, Electron 43)

A `<webview>` guest is an inner WebContents in the window's frame tree. Chromium routes input by
that tree's focus, not by which debugger the command arrived on. A hidden-window probe (host
`<textarea>` focused, guest page logging its own events) measured:

| Input                                                                         | Where it lands             | Host focus                                            |
| ----------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------- |
| CDP `Input.dispatchKeyEvent` / `Input.insertText` on the guest's main session | **host textarea**          | kept                                                  |
| same, with `Emulation.setFocusEmulationEnabled`                               | **host textarea**          | kept                                                  |
| `webContents.sendInputEvent` key / `char` on the guest                        | guest                      | kept                                                  |
| CDP key / `insertText` on a cross-site iframe's own (auto-attached) session   | that iframe                | kept                                                  |
| `webContents.insertText` with focus in a cross-site iframe                    | **guest renderer crashed** | —                                                     |
| `sendInputEvent` key with focus in a same-site iframe                         | that iframe                | kept                                                  |
| any mouse press (CDP mouse, touch, tap gesture, `sendInputEvent`)             | guest                      | **moved to the webview**                              |
| `inert` / `tabindex=-1` on the `<webview>` during the press                   | guest                      | **moved**                                             |
| press + synchronous host restore on the `<webview>` `focus` event             | guest                      | restored, next user key lands in the host             |
| the restore above with focus emulation enabled first                          | guest                      | **not restored** (the host `focus` event never fires) |

With focus emulation on, the press still moves focus and the restore on the `focus` event never
runs, but restoring when the press ends works and the page sees no blur, so a menu or picker the
agent just opened stays open.

In a visible window (Xvfb with a window manager, keys typed with `xdotool`), the user's real
keystrokes follow the host page's DOM focus: after an agent press and the restore below they reach
the host's focused element. `webContents.getFocusedWebContents()` reports the guest whenever a
`<webview>` exists, even before any input, so it cannot tell where typing goes.

So:

- Keys and text must be sent to the guest directly, not over the main-session CDP `Input` domain,
  and never with `webContents.insertText`. Cross-site iframe sessions already route correctly.
- A mouse press always moves focus in Chromium. The host renderer has to put it back when the
  press ends, and only for input an agent started.
- Focus emulation keeps the page from seeing that hand-back as a blur.
- `webContents.focus()` on a guest is only acceptable while the pane is holding the user's focus
  to give back.

Offscreen rendering (pages painted into a canvas) avoids all of this, but rebuilds every native
popup and copies every frame. It stays an experiment, not the fix.

## Design

1. **No focus side effects from CDP.** The proxy answers `Page.bringToFront` and
   `Target.activateTarget` without focusing anything.
2. **Keys and text go straight to the guest.** For an embedded guest, main-session
   `Input.dispatchKeyEvent` / `Input.insertText` (from the proxy) and Orca's own `keypress` become
   `sendInputEvent` key / `char` events with `skipIfUnhandled`, followed by a page round trip so
   the reply comes after the page handled them. When the page's focus sits in a cross-site
   frame, keys and text go to that frame's own CDP target session instead: main follows
   `document.activeElement` through frame elements (`DOM.describeNode` gives the frame id, which
   is the frame's target id), attaches with `Target.attachToTarget {flatten:true}`, enables focus
   emulation there and sends the input on that session. A same-site frame shares the guest's
   renderer, so widget events already reach it. The proxy hides these Orca-owned sessions' events
   from the agent's client. Offscreen and headless pages have no host frame tree and keep CDP.
3. **Agent input that needs focus borrows it.** Before a press, or before input only CDP can
   express (a frame that cannot be reached, text with control characters, unmapped keys,
   root-session IME composition), main enables focus emulation and asks the hosting pane to note the user's
   focused element, waiting for its answer. When the input ends the pane gives focus back, and
   checks again 50 ms later in case Chromium's focus move arrived after the end message. Nothing is
   restored when the user already had focus in that page.
   If the pane does not answer, the input is refused with `browser_focus_guard_unavailable`
   rather than sent. Agent Tab keys take the same guard, because Tab from the page's last field
   moves focus out of the guest into Orca's window.
   While the user's IME composition is open the pane answers `composing` and main refuses the
   input, because the blur would commit the unfinished text (into a terminal, that sends it to
   the shell). It is refused rather than held, so a press cannot outlive its agent or land in the
   user's next composition. Direct commands report `browser_user_composing`; commands run through
   the agent-browser helper, like `click`, report `browser_error` with the same retry message.
4. **Agent keys are marked as the agent's.** While agent input is injected, the guest's Orca
   shortcut and grab handlers ignore keys and `setIgnoreMenuShortcuts` keeps unhandled keys
   from Orca's app menu, so an agent's Cmd/Ctrl+T, W or Ctrl+Tab stays in the page. Measured:
   synthetic input never fired the guest's `before-input-event`; the mark is the guarantee.

Known gaps: the user's element is blurred for the length of one agent press, so keys typed in that
window reach the page, and a composition started between the pane's answer and the press is still
committed. Edit commands (`selectAll`, `paste`, ...) run even when the page cancels the key. Focus
emulation stays on while the debugger is attached, so a page the user really leaves sees no blur,
and it covers the main frame only, so a menu inside a cross-site frame can still close. A pane
that misses the 150 ms ready window refuses that input. Only offscreen rendering removes the first
two gaps.

## Tracker

| Step                                                                                              | PR             | State     |
| ------------------------------------------------------------------------------------------------- | -------------- | --------- |
| CDP focus side effects removed (`bringToFront`, `activateTarget`) + this doc                      | stack 1/3      | in review |
| Keys and text delivered to the guest directly                                                     | stack 2/3      | in review |
| Presses and CDP-only input borrow focus and give it back; focus emulation                         | stack 3/3      | in review |
| Regression spec: user typing in a terminal while an agent clicks, types and presses keys          | stack 2/3, 3/3 | in review |
| Visible-window spec (`@headful`, isolated display only): native focus stays on Orca's window      | stack 3/3      | in review |
| Main-session keys and text for a focused cross-site iframe go to its own session, no focus borrow | follow-up PR   | in review |
| Agent presses are refused while the user's IME composition is open (#28700)                       | follow-up PR   | in review |
