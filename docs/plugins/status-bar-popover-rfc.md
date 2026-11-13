# RFC: host-owned plugin status-bar popovers

Status: proposal for maintainer review. This document adds no runtime API.
Related: [#23143](https://github.com/stablyai/orca/issues/23143).

## Problem

Plugins can contribute status-bar counts and commands, but cannot open a
host-owned popover anchored to their item. An overview inside an already-open
sidebar panel does not serve the same purpose: it is unavailable when that panel
is closed and interrupts the panel instead of providing a quick glance.

This gap is observable in desktop 1.4.258 and in the current status-bar item
schema. The existing request in #23143 already proposed a popover entry; this
RFC specifies the remaining lifecycle and permission boundaries.

## Proposed behavior

Extend the existing contribution with an optional popover entry. Reuse the
plugin frame isolation, bridge and approval machinery; do not create a separate
plugin execution environment. The exact manifest shape needs maintainer review.

- The host owns placement, tokens and bounded dimensions, aligned to the clicked
  item and clamped to the viewport. Support narrow layouts, scrolling and zoom.
- Clicking again, Escape or an outside click closes it and returns focus to the
  status item. Only one host status popover is open at once.
- Opening works with the sidebar panel closed. It starts only the already
  approved plugin frame/worker, never an agent, login flow or terminal.
- Give each frame its own identity and close signal. Closing a popover must not
  log out another panel or terminate a shared authenticated worker session.
- An explicit supported visibility event distinguishes visible, hidden and
  closed. A retained hidden frame must not renew a foreground/read lease.
- Existing account and host scopes still apply. A plugin should show a signed-out
  state instead of reading credentials on open. Multiple accounts must not share
  cached private content by accident.
- Showing an overview does not mark messages read, seen or handled. A user click
  may reveal a declared plugin panel and select an authorized item through a
  typed navigation contract. Navigation is not permission to authenticate or
  launch an agent.
- Mobile and older paired clients should ignore unsupported contributions
  safely. Network access continues to run on its declared execution host; the
  popover does not gain filesystem, terminal, secret or workspace privileges.

The existing text/count/command contribution remains compatible. A custom icon
format is separate work; it is not required for popovers.

## Related observation: native notification dispatch

Two explicit plugin notification previews on macOS returned `delivered: true`
but the user observed neither banner nor sound. Notification permission and
presentation surfaces were enabled, system output was unmuted, and the user
reported no Focus or sharing/mirroring. Both attempts were made while interacting
with Orca; a controlled background comparison has not been performed.

In 1.4.258, `notifications.show` delegates to the notification service's plugin
dispatch path. The desktop adapter checks `Notification.isSupported()`, invokes
`new Notification({ title, body }).show()`, then immediately returns `true`.
It does not await Electron's show/failure events. This explains what the return
value proves, not why presentation was absent. Native show callbacks would still
not prove that a person saw or heard an alert.

Document dispatch acceptance separately from presentation. A follow-up transport
change should expose bounded failure/timeout diagnostics without response bodies,
extra privileges, retries, fallback audio or bypassing OS Focus policy. This RFC
does not implement that change or claim a macOS root cause.

## Acceptance for a future implementation

1. A declared plugin item opens a host-anchored popover with its sidebar closed.
2. Keyboard, focus return, outside click and placement work on desktop and a
   390px layout, including zoom and long labels.
3. Two frames sharing a ready account retain one transport. Closing one preserves
   the other; explicit account logout clears private caches and stops its pump.
4. Hidden/closed frames do not create read acknowledgements or foreground leases.
5. Counts survive mute without sound or attention alarms. Initial history,
   reconnect backlog and duplicate events do not produce fresh alerts.
6. No credential read, new model, terminal input, private host RPC or permission
   expansion occurs merely because the popover opens.
7. Validate macOS/Linux/Windows and paired/SSH behavior before release. Fixtures
   are separate from actual OS permission, banner, sound and user acceptance.
