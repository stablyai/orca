## ADDED Requirements

### Requirement: The relocated daemon reflects the installed application

The PTY daemon runs from a copy of the application materialised into a local directory. That copy SHALL be refreshed whenever the installed application's daemon sources differ from it. Deciding solely on the application's version string is insufficient: two builds can share a version and differ in content, and the daemon then keeps executing stale code indefinitely while every visible artifact — the build output, the installer, the installed application — appears correct.

#### Scenario: Installed application changes without a version change
- **WHEN** the application is reinstalled with the same version string but different daemon sources
- **THEN** the materialised daemon host is refreshed from the new sources

#### Scenario: Installed application is unchanged
- **WHEN** the materialised host already matches the installed daemon sources
- **THEN** it is reused, with no copying

#### Scenario: A stale host is detected while the daemon is running
- **WHEN** a refresh is required but the running daemon holds files in the destination
- **THEN** the condition is surfaced rather than silently swallowed, so it is not mistaken for a successful refresh

### Requirement: A failed refresh is observable

Materialisation currently catches every failure and returns a fallback result. A refresh that cannot complete SHALL leave a trace that distinguishes "up to date" from "could not update", because the two are indistinguishable at the point where behaviour diverges — the running daemon executes old code while every artifact check passes.

#### Scenario: Publication cannot replace the destination
- **WHEN** replacing the destination fails because a live process holds a file in it
- **THEN** the failure is recorded, rather than only being inferable from behaviour later

### Requirement: A daemon refresh can be forced

Until refresh is content-aware, there SHALL be a supported way to force one, because the natural remedies do not work and each fails silently.

#### Scenario: Reinstalling the application
- **WHEN** the application is reinstalled at the same version
- **THEN** the daemon host is not refreshed by that act alone

#### Scenario: Stopping the daemon without clearing the marker
- **WHEN** the daemon process is stopped and the application restarted, with the completion marker intact
- **THEN** materialisation short-circuits on the marker and the stale host is reused

#### Scenario: Clearing the marker with the daemon stopped
- **WHEN** the completion marker is removed and the application starts with no daemon holding the destination
- **THEN** the host is re-copied from the installed application and the marker records the new completion
