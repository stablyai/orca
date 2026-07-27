# Codex Micro Full-Parity Support

**Status:** Approved; hardware protocol discovery pending

**Date:** 2026-07-27

## Summary

Orca will add first-class Codex Micro support on macOS, Windows, and Linux. The integration separates hardware transport, Orca device behavior, and agent-provider control APIs. Orca owns the hardware transport while enabled, supports every tracked agent for status and navigation, and provides reliable controls for Codex, Claude, and Gemini before the Experimental preview ships.

The user-facing behavior follows the official [Codex Micro documentation](https://learn.chatgpt.com/docs/features/codex-micro). Codex controls use version-matched [Codex App Server](https://learn.chatgpt.com/docs/app-server) schemas.

## Goals

- Match documented Codex Micro lighting, navigation, command, microphone, joystick, and dial behavior.
- Support all tracked Orca agents for status display and navigation.
- Provide complete default controls for Codex, Claude, and Gemini through reliable APIs or native Orca hooks.
- Work across local, WSL, SSH, and relay-backed sessions without synthesizing terminal keystrokes.
- Preserve Work Louder input layers 2–6 and leave firmware updates vendor-owned.
- Ship behind Experimental after the hardware, platform, provider, reliability, privacy, and latency gates pass.

## Non-goals

- Sharing the device dynamically with ChatGPT while Orca owns it.
- Reverse-engineering or writing unknown firmware without validated report captures.
- Managing vendor firmware updates.
- Replacing Work Louder layers 2–6.
- Adding GitHub-specific assumptions to generic agent or review behavior.

## Design Principles

### Separate the three control layers

1. **Hardware transport:** a Rust sidecar discovers, claims, reads, and writes the physical device.
2. **Orca device behavior:** Electron projects agent state into six slots, resolves gestures, dispatches mapped actions, and computes lighting snapshots.
3. **Provider control:** typed adapters perform agent-specific actions on the execution host that owns the session.

No layer may bypass the next layer by synthesizing terminal input. This keeps controls reliable for native, WSL, SSH, relay, and folder-workspace sessions.

### Fail closed around unknown hardware

Production HID writes require vendor documentation or captured golden report fixtures from a physical device. Unknown firmware stays read-only until its capabilities are proven. The simulator and fake HID transport may exercise unverified behavior, but production transport must never guess descriptors, report IDs, or payload layouts.

### Explicit exclusive ownership

Settings expose a **Use with Orca** switch. Enabling it makes Orca claim the device exclusively. A conflict with ChatGPT or another owner produces a recoverable error with release and retry controls. Orca does not silently steal or dynamically share ownership.

## Architecture

```text
Codex Micro USB/BLE
        │
        ▼
Rust hidapi sidecar
  discovery · claim · codec · reconnect · capabilities · battery
        │ versioned length-delimited JSON over stdio
        ▼
Electron main coordinator
  ownership · process lifecycle · snapshots · gesture timing · IPC
        │
        ├──────────────► renderer settings and navigation
        │
        ▼
AgentControlAdapter registry
        │
        ├─ native host
        ├─ WSL host
        ├─ SSH host
        └─ relay host
              │
              ├─ Codex App Server
              ├─ Claude Orca adapter/hooks
              └─ Gemini Orca adapter/hooks
```

### Rust sidecar

The sidecar lives under `native/codex-micro/` and uses Rust with `hidapi`. It owns:

- USB and BLE discovery
- exclusive claim and release
- input report decoding and output report encoding
- reconnect and hot-plug handling
- capability negotiation by firmware identity
- battery reporting when exposed by the device
- duplicate output-snapshot suppression
- redacted diagnostics
- a simulator and fake HID transport

The binary must be packaged and signed with Orca. Linux builds must target Ubuntu 20.04 and glibc 2.31.

### Sidecar protocol

Electron and the sidecar communicate over stdio using versioned, length-delimited JSON frames. The length prefix prevents partial reads and concatenated JSON from becoming ambiguous. Both sides reject oversized, malformed, or unsupported-version frames without logging raw reports.

The handshake negotiates protocol version and reports sidecar/device capabilities. Messages cover:

- handshake and capability negotiation
- discovery and connection state
- claim and release
- full output snapshots
- decoded input events
- battery state
- recoverable and terminal errors
- redacted diagnostic summaries

Output uses idempotent full snapshots rather than incremental RGB commands. Receiving the same snapshot twice must not produce another HID write.

### Electron coordinator

Electron main owns sidecar startup, shutdown, crash recovery, exponential reconnect, ownership state, and renderer IPC. The coordinator is disabled in web builds. Its interfaces are transport-agnostic so tests can substitute a fake sidecar.

The coordinator receives tracked agent state, computes the selected slot and full lighting snapshot, and sends only changed snapshots to the sidecar. Input gestures become typed device actions before dispatch.

### Shared contracts

Shared TypeScript contracts cover:

- `CodexMicroSettings`
- device and transport state
- firmware capabilities and compatibility state
- agent-source policy and six slot assignments
- durable pinned provider-session identities
- lighting snapshots and status colors
- physical control mappings
- discriminated device actions
- `AgentControlAdapter` capabilities and results
- explicit completion outcomes

Device actions are discriminated as:

- Orca commands
- provider controls
- quick commands
- installed skills

Adapter results are typed as success, unsupported, or failure. Completion outcomes are explicit: completed, failed, or interrupted. A normal interrupted session must not light as a failure.

### Execution-host routing

Provider actions execute on the host that owns the session: native, a specific WSL distro, an SSH provider, or a relay connection. Capability caches and process state are scoped to that host identity. Folder workspaces are supported without assuming a Git worktree exists.

Codex uses the `codex app-server` executable and JSON schemas from the same installed Codex version. Claude and Gemini use equivalent reliable Orca adapters or native hooks. Terminal keystroke synthesis is not an adapter fallback.

## Agent Slot Projection

The device exposes six agent slots. Settings offer these policies:

- **Hybrid** — default; durable pins keep their slots and remaining slots are filled by recent relevant sessions.
- **Recent** — the six most recently active eligible sessions.
- **Pinned** — only explicitly pinned sessions.
- **Priority** — sessions ordered by attention priority, then recency.
- **Custom** — explicit per-slot assignments.

Pins use durable provider-session identity rather than transient terminal or renderer IDs. Projection is deterministic for the same inputs. More than six agents remain tracked and can replace dynamic slots as policy inputs change.

Every tracked provider can supply status and navigation even if it does not implement provider controls. An unassigned Agent Key starts a session using the workspace's default agent.

## Lighting

Agent Key lighting matches the official behavior:

| State | Color/behavior |
| --- | --- |
| Unassigned | Off |
| Idle | White |
| Working | Blue |
| Awaiting input | Amber |
| Completed with unread update | Green |
| Explicit failure | Red |
| Selected session | Pulse its current status color |

The lighting model consumes explicit completion outcomes. Interrupted is not mapped to red unless the provider reports an actual failure.

Brightness and idle-light timeout are configurable. The sidecar performs no write when the computed output snapshot is unchanged.

## Physical Controls

### Agent Keys

- Single press navigates to the assigned session without raising Orca.
- Double press within 350 ms navigates and raises Orca.
- Pressing an unassigned key starts a session with the workspace's default agent.
- While dial UI is open, the Agent Key immediately to the right of the dial lights red and acts as Cancel.

Navigation must work while Orca is in the background. Raising is reserved for the documented double press.

### Command Keys

Default mappings are:

1. Fast mode
2. Approve
3. Decline
4. Continue in new chat
5. Push-to-talk
6. Send

Every Command Key can instead map to an Orca command, provider control, quick command, or installed skill.

### Microphone

- Hold the Mic key for push-to-talk recording.
- Double-tap within 350 ms for hands-free recording.
- Use the documented sea-green/white lighting sequence while recording and preparing the prompt.
- The device has no microphone; recording uses the computer's microphone through Orca.

### Joystick

Default directions are:

- Up: Plan mode
- Right: history forward
- Down: sidebar toggle
- Left: history back

Each direction is remappable to any supported device action.

### Dial

The dial supports:

- **Composer Navigation** — move through composer controls/options, press to select.
- **Reasoning Only** — open and adjust reasoning effort.

Long-pressing the dial for 500 ms opens Codex Micro settings. While dial UI is open, the adjacent Agent Key becomes the red Cancel control.

### Unique keycaps

Keycap mappings are unique. Assigning a keycap already in use swaps the conflicting assignments instead of creating duplicates.

## Settings Experience

Add **Settings → AI Capabilities → Codex Micro** following `docs/STYLEGUIDE.md`, the tokens in `src/renderer/src/assets/main.css`, and existing shadcn primitives.

The pane contains:

- Experimental status and the explicit **Use with Orca** ownership switch
- device, transport, connection, firmware, compatibility, and battery state
- brightness and idle-light timeout
- six slot assignments and pin controls
- slot policy selection
- physical control map
- searchable action picker
- provider Fast levels
- dial mode
- collapsed reconnect, release, compatibility, and redacted diagnostics controls
- Linux AppImage permission/setup guidance where applicable

The pane must remain usable with no device attached and explain read-only unknown-firmware mode. Diagnostics never include serial numbers, raw reports, prompts, paths, or session IDs.

## Provider Control Contract

`AgentControlAdapter` advertises capabilities before dispatch. The default provider-control set is:

- toggle/set Fast mode where supported
- approve the current request
- decline the current request
- continue the current chat in a new chat
- start/stop microphone capture through Orca
- send the current composer content
- adjust Plan/reasoning mode where supported

Codex, Claude, and Gemini must implement every default control that their Orca session UI exposes reliably before preview. Unsupported actions return a typed unsupported result and are disabled or explained in the mapping UI. Provider failures remain distinguishable from unsupported capabilities.

## Packaging and Platform Behavior

- Package the sidecar for macOS, Windows, Linux x64, and supported arm64 targets.
- Sign/notarize it with the desktop application where required.
- Bundle Linux udev rules in deb packages.
- Provide AppImage setup guidance because AppImage cannot install udev rules automatically.
- Keep the Linux native binary compatible with Ubuntu 20.04/glibc 2.31.
- Use platform path APIs for sidecar and resource locations.
- Exclude all device ownership and sidecar behavior from web builds.

## Privacy and Diagnostics

The Experimental feature collects only coarse opt-in health signals needed to assess compatibility and reliability. It must not collect:

- device serial numbers
- raw HID reports
- prompts or responses
- filesystem paths
- provider session IDs

Local diagnostics are redacted using the same rules. Errors may include coarse transport, firmware compatibility class, reconnect reason, and sidecar exit classification.

## Failure Handling

- Unknown firmware: remain connected read-only and show compatibility guidance.
- Ownership conflict: show the current inability to claim, plus release/retry actions.
- Permissions failure: show platform-specific recovery guidance.
- Disconnect or sleep: preserve desired ownership and reconnect when the device returns.
- Sidecar crash: restart with bounded backoff and restore the latest full snapshot after a new handshake.
- Provider unsupported action: return unsupported without terminal input fallback.
- Provider failure: surface failure without changing the agent completion outcome unless the provider reports the session failed.

## Delivery Sequence

1. Capture and document the owned device's USB/BLE descriptors, reports, gestures, RGB writes, firmware behavior, and ownership conflicts. Prefer vendor documentation and create golden fixtures before production writes.
2. Build the Rust bridge, simulator, framing, packaging, signing hooks, crash recovery, and Electron coordinator.
3. Add deterministic slot projection, lighting, navigation, settings persistence, action dispatch, and settings UI.
4. Add Codex, Claude, and Gemini adapter contract suites and execution-host routing.
5. Enable an Experimental preview only after every release gate below passes.

## Verification

### Automated

- Rust codec, malformed-input, reconnect, unknown-firmware, USB/BLE, fake-HID, duplicate-snapshot, and redaction tests
- TypeScript slot allocation, pin restoration, status/outcome, mappings, migrations, capability, IPC, and host-routing tests
- Electron fake-sidecar tests for claiming, gestures, lighting, remapping, disconnects, crashes, permissions, and web exclusion
- Codex, Claude, and Gemini adapter contract suites
- packaging checks for every desktop target and the Linux glibc floor

### Physical matrix

Cover macOS, Windows, and Linux over USB and BLE, including:

- sleep and wake
- hot-plug and removal
- ChatGPT ownership conflicts
- background navigation and foreground raising
- application and sidecar restart
- native, WSL, SSH, relay, and folder-workspace sessions
- more than six tracked agents
- both supported firmware versions required for Stable

### Performance

- Input dispatch under 100 ms p95
- Status updates reaching the sidecar under 250 ms p95
- Duplicate output snapshots producing zero HID writes

## Release Gates

The Experimental preview requires:

- golden report fixtures and safe production writes for a known firmware
- full automated suites passing
- Codex, Claude, and Gemini covering every default provider control reliably
- platform packaging and permission guidance complete
- physical USB and BLE validation on macOS, Windows, and Linux
- privacy/redaction review complete

Stable promotion requires the full platform/provider matrix across two supported firmware versions, or one firmware version plus proven capability-negotiated forward compatibility.

## Current Handoff State

The architecture and behavior in this document are approved. No Codex Micro was visible on the VPS used to prepare the design, so no USB/BLE descriptors or HID reports were captured and no production hardware implementation was started. The official OpenAI developer-docs MCP connector was installed globally on that VPS, but this is workstation configuration and is not part of the repository.

Resume on a workstation with the physical device attached. The first implementation action is passive USB/BLE discovery and report capture. Do not add production writes until vendor documentation or golden fixtures prove the report format.
