# Orca iOS Companion Architecture

## Goal

Let a user continue an existing Orca session from an iPhone while the laptop stays open and remains the authoritative runtime. The phone is a remote surface for the same PTY-backed sessions, not a second local execution environment.

## Product Cut For The First Architecture PR

This PR intentionally scaffolds the backend shape before any iOS UI exists:

- define the shared protocol and payloads the phone app will consume
- define how Orca represents remote-manageable sessions
- define the pairing model for a single owner-controlled device
- keep the laptop as the only place where commands actually run

Out of scope for this PR:

- SwiftUI screens
- push notifications
- cloud relay infrastructure
- remote wake or background execution when the laptop is closed
- multi-user collaboration

## Core Model

One remote session maps to one live Orca PTY leaf, not one repo or one worktree.

Why:

- users want to continue the exact conversation they already have open
- a worktree can contain multiple parallel agent panes with different contexts
- leaf-level identity keeps "send input", "interrupt", and "approve" targeted and predictable

The existing `OrcaRuntimeService` already owns the truthful view of live terminals. The companion architecture therefore layers on top of runtime terminal summaries instead of inventing a second session registry.

## Ownership Boundary

The laptop remains the control plane:

- session discovery comes from `OrcaRuntimeService`
- terminal writes still go through the main-process PTY controller
- approval decisions are forwarded back into Orca's existing command flow
- the phone never runs shell commands locally on behalf of Orca

This keeps the first version aligned with the user's mental model: "my laptop is doing the work; my phone is steering."

## Transport Shape

Phase 1 uses `local_only` transport:

- Orca generates a short-lived pairing token
- the phone scans a QR payload
- the iPhone connects over the local network to a main-process remote-control endpoint
- Orca validates the token and starts streaming session snapshots and output updates

The shared protocol already includes a `relay` transport mode so a future PR can add Cloudflare Tunnel or a hosted relay without replacing the message schema.

## Security Model

The first version assumes a single owner device and optimizes for explicit opt-in:

- remote control is disabled by default
- enabling it creates a short-lived pairing token
- tokens expire automatically
- disabling remote control invalidates the active pairing state
- the service exposes capability levels per session so read-only fallback remains possible if a terminal is not writable

This architecture deliberately avoids persistent broad-scope bearer tokens in the first PR.

## Protocol Surface

The shared protocol lives in `src/shared/remote-control-types.ts`.

Main concepts:

- `RemoteControlSnapshot`: full state sent to the phone
- `RemoteControlSession`: one PTY leaf exposed as one phone-manageable session
- `RemoteControlPairingState`: short-lived QR/bootstrap payload
- `RemoteControlClientCommand`: initial command set for listing, focusing, input, and approvals
- `RemoteControlServerEvent`: initial event set for snapshots, output streaming, and exits

This is intentionally small. The point is to lock down the control-plane contract early so later UI work does not invent ad hoc payloads.

## Service Boundary

The main-process service lives in `src/main/remote-control/service.ts`.

Responsibilities:

- manage enabled/disabled remote-control state
- mint and rotate pairing payloads
- translate runtime terminals into remote sessions
- expose a snapshot method that future IPC, WebSocket, or HTTP layers can call

Non-responsibilities:

- hosting a WebSocket server in this PR
- pushing renderer UI
- storing long-term device registrations

That split keeps this PR reviewable. The next PR can add the network transport around a service boundary that already exists.

## Suggested Follow-Up PR Order

1. Add a main-process WebSocket endpoint and wire it to `RemoteControlService`.
2. Add a settings toggle plus QR pairing UI in desktop Orca.
3. Scaffold the SwiftUI iPhone app against the shared protocol.
4. Add approval cards, output streaming, and session switching.
5. Add optional relay mode for away-from-home access.

## Why This Cut

The biggest failure mode would be building a polished phone UI before the session identity, transport, and security boundaries are stable. This PR fixes that by making the architecture concrete in the codebase first, while still staying small enough to review as an initial design-and-scaffold change.
