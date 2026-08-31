# macOS keep-awake integrations

The On / Agent / Off setting decides when Orca wants the Mac awake. Orca owns
that assertion through Electron's `powerSaveBlocker` and `/usr/bin/caffeinate
-i -s`.

The macOS integration preference controls whether Orca also observes
Amphetamine:

| Preference    | Orca-owned mechanism | Amphetamine behavior                         |
| ------------- | -------------------- | -------------------------------------------- |
| `caffeinate`  | `caffeinate -i -s`   | None                                         |
| `amphetamine` | `caffeinate -i -s`   | Read-only observation of an existing session |

Amphetamine is additive. Caffeinate remains active in both modes and is the
only process-level assertion Orca starts and stops.

## Why the integration is read-only

Amphetamine exposes one global session for the machine. Its scripting API has
`start new session` and `end session`, but no session id, owner, tag, targeted
end command, or compare-and-swap operation.

Both writes can destroy another actor's state:

- `start new session` ends the current session, including Trigger sessions.
- `end session` ends whichever session is current when the command arrives.

Session shape cannot establish provenance. An indefinite session that permits
display sleep may have been created by the user, another Orca runtime, or an
older build. A check immediately before a write is also insufficient because
AppleScript sends separate Apple events; another session can replace it between
the read and the write.

Therefore Orca never sends either session write and never infers ownership from
shape or an ambiguous command result. It also never changes Amphetamine's
display-sleep, screen-saver, closed-display, Trigger, or Drive Alive
preferences.

This is a deliberate feature tradeoff. Users who select the Amphetamine
integration must start a session or configure a Trigger in Amphetamine. If no
session is active, Orca still keeps the Mac awake through caffeinate, but
Amphetamine-specific behavior is not active. Closed-display behavior remains
subject to Amphetamine and macOS configuration.

## Observation lifecycle

When the integration is selected and awake mode is active, Orca runs a
read-only AppleScript that:

1. checks whether Amphetamine is already running, without launching it;
2. reads whether its global session is active;
3. returns `active` or `inactive`.

The observation is repeated every 30 seconds because a user-controlled session
can start, expire, or be replaced. `amphetamineActive` is true only after a
successful `active` observation in the current lifecycle. An inactive,
unparseable, failed, timed-out, stopped, or disposed observation publishes
false.

Stopping or disposing the service aborts an in-flight observation, clears local
state, and sends no Amphetamine command. A late result is generation-fenced and
cannot restore state or publish after teardown. A second Orca runtime and a
runtime restarted after a crash independently observe the same session; neither
can alter it.

## Failure and retry policy

- `not-installed` and `automation-denied` are terminal until an explicit user
  retry. They cancel periodic and backoff timers.
- Other observation failures publish inactive, back off for 30 seconds, and
  then retry. Successful observation restores the periodic timer.
- An Automation denial is cleared only by Check again or re-selecting the
  integration after the permission is fixed.
- A positive explicit installation probe clears a stale `not-installed`
  verdict and resumes observation. It does not clear `automation-denied`.

Installation detection resolves the bundle through Launch Services and is
separate from session observation. Status rendering performs at most one lazy
probe per runtime, including when that probe is inconclusive. The explicit
probe action is the retry path after installation and may run again. Disposal
aborts an in-flight installation lookup as well as session observation.

## Status and mixed versions

The host publishes optional `macosEngine`, `amphetamineInstalled`,
`amphetamineUnavailableReason`, and `amphetamineActive` fields. Optional fields
preserve compatibility with clients and hosts that update independently.

`macosEngine: "amphetamine"` records the preference; it does not mean
Amphetamine currently backs the session. Consumers should display Caffeinate as
the effective assertion while `amphetamineActive` is false, and Caffeinate plus
Amphetamine only while it is true.

## Remote and paired-web boundary

Keep-awake assertions stay on the host running the service and are never
forwarded across SSH or a relay. Amphetamine observation runs only in a desktop
window runtime; headless serve keeps Caffeinate but skips the unused observer.
The host's `process.platform` decides whether the macOS integration can run.

Paired-web clients hide these controls. Their web preload reports an inactive
status and makes the installation probe a no-op, so a browser client cannot
open the App Store or send Apple events on either machine.
