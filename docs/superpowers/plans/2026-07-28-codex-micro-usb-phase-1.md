# Codex Micro USB Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Every production change follows RED → GREEN → REFACTOR.

**Goal:** Add a useful, cross-platform Codex Micro USB preview to Orca: safe v0.4.1 device input, reversible runtime lighting, existing Orca action mappings, and a dedicated Settings → AI Capabilities → Codex Micro screen.

**Architecture:** A small Rust `hidapi` sidecar owns USB access. Electron main supervises it and exposes typed, redacted state/events through preload IPC. The renderer maps proven hardware events to Orca's existing `KeybindingActionId` dispatcher and presents settings built from Orca's existing controls. The device protocol and sidecar protocol stay separate and fixture-tested.

**Tech Stack:** Rust stable, `hidapi`, `serde`, `serde_json`; Electron main/preload; React 19; TypeScript 7; Vitest; pnpm 10.24; electron-builder.

## Global Constraints

- Production support is USB only, VID:PID `303a:8360`, known firmware exactly `v0.4.1`.
- Unknown or malformed firmware remains connected read-only. No runtime output commands are allowed.
- Never issue firmware, bootloader, filesystem, keymap, profile, or layer writes.
- Runtime `v.oai.rgbcfg` and `v.oai.thstatus` writes are optional, deduplicated, and never blindly retried after an indeterminate acknowledgement.
- Parse complete `v.oai.hid` and `v.oai.rad` events independently from command acknowledgement assembly; input must survive output corruption/timeouts.
- Do not persist or log serial numbers, raw reports, prompts, paths, or provider session IDs.
- The feature is off by default and desktop-only. Web builds expose no device behavior or settings entry.
- Use `KeybindingActionId`, `KEYBINDING_DEFINITIONS`, and `dispatchAppCommand`; do not create a second Orca action registry.
- Follow `AGENTS.md` and `docs/STYLEGUIDE.md`; use existing UI primitives and tokens; add no max-lines disables.
- Preserve macOS, Windows, Linux, SSH, relay, and folder-workspace behavior. Hardware ownership remains local to the Orca desktop client.
- Linux binaries must meet the Ubuntu 20.04 / glibc 2.31 floor.
- Phase 1 adds no BLE, microphone flow, provider-control API, radar actions, device profile editing, or multi-device selection.

## Environment Gate

The implementation worktree is `/opt/data/home/orca-worktrees/codex-micro-support` on `feat/codex-micro-support`.

Current container preflight found Node `22.22.3` while Orca requires Node `24`, and no Rust toolchain. Before baseline tests:

```bash
node --version
cargo --version
rustc --version
```

Required result: Node 24.x plus a persistent Rust stable toolchain. Install both outside the repository under `/opt/data/home` so container replacement does not remove them. Do not alter Orca source to accommodate the older container Node.

---

## Task 1: Add redacted golden fixtures and shared device contracts

**Files:**
- Create: `native/codex-micro/fixtures/PROVENANCE.md`
- Create: `native/codex-micro/fixtures/input-events.json`
- Create: `native/codex-micro/fixtures/radar-events.json`
- Create: `native/codex-micro/fixtures/device-status.json`
- Create: `native/codex-micro/fixtures/runtime-output.json`
- Create: `native/codex-micro/fixtures/interleaved-report6.json`
- Create: `src/shared/codex-micro-types.ts`
- Create: `src/shared/codex-micro-types.test.ts`

**Consumes:** Capture artifacts under `/opt/data/artifacts/codex-micro/`.

**Produces:**

```ts
export type CodexMicroConnectionState =
  | { kind: 'disabled' | 'disconnected' | 'connecting' }
  | { kind: 'connected'; firmware: 'v0.4.1'; battery?: number; charging?: boolean }
  | { kind: 'read-only'; firmware: string | null; reason: 'unknown-firmware' }
  | { kind: 'conflict' | 'permission-error' | 'error'; code: string; message: string }

export type CodexMicroControlId =
  | 'AG00' | 'AG01' | 'AG02' | 'AG03' | 'AG04' | 'AG05'
  | 'ACT06' | 'ACT07' | 'ACT08' | 'ACT09' | 'ACT10' | 'ACT11' | 'ACT12'
  | 'ENC_CC' | 'ENC_CW' | 'ENC_CLK'

export type CodexMicroInputEvent =
  | { kind: 'control'; control: CodexMicroControlId; action: 0 | 1 | 2 }
  | { kind: 'radar'; angle: number; distance: number }
```

- [ ] **RED:** Add tests requiring rejection of unknown controls/actions, non-finite radar values, and unredacted error payload keys.

Run:

```bash
pnpm vitest run src/shared/codex-micro-types.test.ts
```

Expected: fail because `codex-micro-types.ts` does not exist.

- [ ] **GREEN:** Add narrow parsers/type guards. Generate fixtures from `analysis.json` and `directed-analysis.json`, preserving only the command/event bytes needed by tests. Replace serial/battery identifiers with stable fixture values and record every transformation in `PROVENANCE.md`.

- [ ] **VERIFY:** Re-run the focused test and scan committed fixtures for the captured serial `A4CB8FC55C30`; the scan must return no matches.

- [ ] **COMMIT:** `test(codex-micro): add redacted capture fixtures and shared contracts`

---

## Task 2: Implement the Rust Report 6 codec and event-first parser

**Files:**
- Create: `native/codex-micro/Cargo.toml`
- Create: `native/codex-micro/Cargo.lock`
- Create: `native/codex-micro/src/lib.rs`
- Create: `native/codex-micro/src/report6.rs`
- Create: `native/codex-micro/src/events.rs`
- Create: `native/codex-micro/tests/report6_fixtures.rs`

**Produces:**

```rust
pub enum DeviceEvent {
    Control { control: ControlId, action: u8 },
    Radar { angle: f64, distance: f64 },
}

pub struct Report6Parser;
impl Report6Parser {
    pub fn push_report(&mut self, report: &[u8]) -> ParseResult;
}

pub struct ParseResult {
    pub events: Vec<DeviceEvent>,
    pub response_chunks: Vec<Vec<u8>>,
}
```

- [ ] **RED:** Fixture tests require `[0x06, 0x02, len, payload…]`, reject length over 61, emit complete HID/radar JSON found in a report, and preserve only non-event bytes for response assembly.

Run:

```bash
cargo test --manifest-path native/codex-micro/Cargo.toml --test report6_fixtures
```

Expected: compile failure because the crate/parser does not exist.

- [ ] **GREEN:** Use stdlib byte scanning plus `serde_json`; no regex and no parser framework. Locate event object starts, extract balanced JSON while respecting quoted strings/escapes, emit valid `v.oai.hid`/`v.oai.rad`, and leave acknowledgement fragments indeterminate when clean reconstruction is impossible. Never sacrifice a complete input event to recover an acknowledgement.

- [ ] **VERIFY:** Focused Rust tests pass, including the captured report containing both a response prefix and `AG00` event prefix.

- [ ] **COMMIT:** `feat(codex-micro): decode event-first Report 6 traffic`

---

## Task 3: Add transport, firmware gate, command framing, and simulator

**Files:**
- Create: `native/codex-micro/src/transport.rs`
- Create: `native/codex-micro/src/device.rs`
- Create: `native/codex-micro/src/runtime_commands.rs`
- Create: `native/codex-micro/src/sidecar_protocol.rs`
- Create: `native/codex-micro/src/main.rs`
- Create: `native/codex-micro/tests/simulator.rs`
- Modify: `native/codex-micro/src/lib.rs`
- Modify: `native/codex-micro/Cargo.toml`

**Produces:**

```rust
pub trait DeviceTransport: Send {
    fn read_timeout(&self, buffer: &mut [u8], timeout_ms: i32) -> Result<usize, TransportError>;
    fn write(&self, report: &[u8]) -> Result<usize, TransportError>;
}

pub enum FirmwareAccess { ReadWrite, ReadOnly }
pub fn classify_firmware(value: Option<&str>) -> FirmwareAccess;
```

Sidecar stdio messages use a four-byte big-endian JSON length followed by `{ "version": 1, "type": … }`. HID Report 6 continues using its captured three-byte header; the formats must never share a codec.

- [ ] **RED:** Tests require exact VID/PID constants, `v0.4.1` read/write, all other firmware read-only, monotonically increasing request IDs, no automatic retry of runtime state commands, duplicate snapshot suppression, and simulator event replay.

Run:

```bash
cargo test --manifest-path native/codex-micro/Cargo.toml
```

Expected: failures for missing transport/device/command modules.

- [ ] **GREEN:** Add target-specific `hidapi` features, a real path-opening transport, and a fixture simulator selected with `--simulate <fixture-dir>`. Query `device.status` before enabling runtime writes. Emit redacted state and typed events. Accept matching acks when complete; time out to `indeterminate` without resending `v.oai.rgbcfg` or `v.oai.thstatus`.

- [ ] **VERIFY:** `cargo test` passes and a simulator process emits the expected AG/ACT/encoder/radar events through framed stdout.

- [ ] **COMMIT:** `feat(codex-micro): add HID transport and simulator sidecar`

---

## Task 4: Add persisted settings and existing Orca action mappings

**Files:**
- Create: `src/shared/codex-micro-settings.ts`
- Create: `src/shared/codex-micro-settings.test.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/shared/constants.ts`
- Modify: `src/main/ipc/settings.ts`

**Produces:**

```ts
export type CodexMicroDialMode = 'navigate' | 'scroll'
export type CodexMicroSettings = {
  enabled: boolean
  lightingEnabled: boolean
  brightness: number
  idleTimeoutSeconds: number
  mappings: Partial<Record<CodexMicroControlId, KeybindingActionId>>
  dialMode: CodexMicroDialMode
}

export const DEFAULT_CODEX_MICRO_SETTINGS: CodexMicroSettings
export function normalizeCodexMicroSettings(value: unknown): CodexMicroSettings
```

Capture-derived defaults map only proven controls to safe existing actions:

- `AG00` → `worktree.navigateUp`
- `AG01` → `worktree.navigateDown`
- `ACT06` → `worktree.history.back`
- `ACT07` → `worktree.history.forward`
- `ACT08` → `sidebar.left.toggle`
- `ENC_CC` → `tab.previousRecent`
- `ENC_CW` → `tab.nextAllTypes`
- `ENC_CLK` → `worktree.palette`

Unlisted controls remain unassigned. Lighting defaults off; brightness remains configurable and clamped to 0–100.

- [ ] **RED:** Tests require default-off ownership/output, stable migration from missing settings, rejection of non-`KeybindingActionId` mappings, brightness/timeout clamping, and preservation of explicit unassigned controls.

Run:

```bash
pnpm vitest run src/shared/codex-micro-settings.test.ts src/main/ipc/settings.test.ts
```

Expected: missing module/type/default failures.

- [ ] **GREEN:** Reuse `KeybindingActionId`, `KEYBINDING_DEFINITIONS`, and `isKeybindingActionId` from `src/shared/keybindings.ts`. Normalize the complete nested settings object at the main IPC trust boundary before persistence.

- [ ] **COMMIT:** `feat(codex-micro): persist validated device mappings`

---

## Task 5: Supervise the sidecar and expose redacted main/preload IPC

**Files:**
- Create: `src/main/codex-micro/sidecar-frame-codec.ts`
- Create: `src/main/codex-micro/sidecar-frame-codec.test.ts`
- Create: `src/main/codex-micro/sidecar-path.ts`
- Create: `src/main/codex-micro/sidecar-process.ts`
- Create: `src/main/codex-micro/sidecar-process.test.ts`
- Create: `src/main/codex-micro/coordinator.ts`
- Create: `src/main/codex-micro/coordinator.test.ts`
- Create: `src/main/ipc/codex-micro.ts`
- Create: `src/main/ipc/codex-micro.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/api-types.ts`
- Modify: `src/preload/index.ts`
- Create: `src/preload/codex-micro-preload.test.ts`

**Produces:**

```ts
window.api.codexMicro = {
  getState(): Promise<CodexMicroConnectionState>,
  retry(): Promise<void>,
  release(): Promise<void>,
  onStateChanged(callback): () => void,
  onInput(callback): () => void
}
```

- [ ] **RED:** Tests require partial/multiple stdio frame decoding, bounded restart after crash, no spawn while disabled, state restoration after reconnect, no restart after explicit release, snapshot dedupe, redacted diagnostics, validated IPC arguments, and listener cleanup.

Run:

```bash
pnpm vitest run \
  src/main/codex-micro/sidecar-frame-codec.test.ts \
  src/main/codex-micro/sidecar-process.test.ts \
  src/main/codex-micro/coordinator.test.ts \
  src/main/ipc/codex-micro.test.ts \
  src/preload/codex-micro-preload.test.ts
```

Expected: missing-module failures.

- [ ] **GREEN:** Spawn a first-party binary with an explicit environment allowlist, `windowsHide: true`, and piped stdio. Coordinator owns settings-driven enable/disable and a bounded backoff. Main broadcasts only parsed state/events. `src/main/index.ts` receives one initializer call; no protocol logic.

- [ ] **COMMIT:** `feat(codex-micro): coordinate sidecar lifecycle and IPC`

---

## Task 6: Dispatch hardware controls through Orca's command path

**Files:**
- Create: `src/renderer/src/lib/codex-micro-command-dispatch.ts`
- Create: `src/renderer/src/lib/codex-micro-command-dispatch.test.ts`
- Modify: `src/renderer/src/lib/app-command-dispatch.ts`
- Modify: `src/renderer/src/App.tsx`

**Produces:**

```ts
export function dispatchCodexMicroInput(
  event: CodexMicroInputEvent,
  settings: CodexMicroSettings
): boolean
```

- [ ] **RED:** Tests require press-only action dispatch for AG/ACT/ENC_CLK, single-step dispatch for ENC_CC/ENC_CW, no release double-fire, no radar dispatch, no action for unassigned/invalid mapping, and source `'codex-micro'` passed to `dispatchAppCommand`.

Run:

```bash
pnpm vitest run src/renderer/src/lib/codex-micro-command-dispatch.test.ts
```

Expected: missing module and unsupported command source.

- [ ] **GREEN:** Extend `AppCommandSource` with `'codex-micro'`. Subscribe once at the App command-dispatch authority and route mapped controls through the registered `dispatchAppCommand`; do not synthesize keyboard events.

- [ ] **COMMIT:** `feat(codex-micro): route controls through Orca commands`

---

## Task 7: Add Settings → AI Capabilities → Codex Micro

**Files:**
- Create: `src/renderer/src/components/settings/codex-micro-search.ts`
- Create: `src/renderer/src/components/settings/codex-micro-search.test.ts`
- Create: `src/renderer/src/components/settings/codex-micro/CodexMicroSettingsPane.tsx`
- Create: `src/renderer/src/components/settings/codex-micro/CodexMicroSettingsPane.test.tsx`
- Create: `src/renderer/src/components/settings/codex-micro/CodexMicroConnectionCard.tsx`
- Create: `src/renderer/src/components/settings/codex-micro/CodexMicroMappingGrid.tsx`
- Modify: `src/renderer/src/hooks/useSettingsNavigationMetadata.ts`
- Modify: `src/renderer/src/components/settings/Settings.tsx`

**Screen contents:**

1. Experimental badge and **Use with Orca** switch.
2. Disconnected/connecting/connected/read-only/conflict/permission/error status card with Retry/Release when valid.
3. Lighting enable, brightness, and idle timeout controls, disabled unless known firmware is writable.
4. Searchable mapping pickers for AG00–AG05, ACT06–ACT12, encoder directions/click, populated from `KEYBINDING_DEFINITIONS`.
5. Dial mode selector.
6. Collapsed diagnostics showing only redacted code/message.

- [ ] **RED:** Navigation tests require the desktop-only capabilities entry and its absence on web. Pane tests require no-device usability, settings persistence, read-only output disabling, mapping updates, and accessible labels/focus.

Run:

```bash
pnpm vitest run \
  src/renderer/src/components/settings/codex-micro-search.test.ts \
  src/renderer/src/components/settings/codex-micro/CodexMicroSettingsPane.test.tsx \
  src/renderer/src/components/settings/SettingsSidebar.test.tsx
```

Expected: missing component/metadata failures.

- [ ] **GREEN:** Mirror existing desktop-only sections. Use `SettingsFormControls`, `Switch`, `Slider`, `Select`, `Popover` + `Command`, `Badge`, `Button`, and `Collapsible`. Keep nav registry and rendered order aligned. Use the existing localization extraction/catalog workflow.

- [ ] **VERIFY:** Run focused tests plus `pnpm run verify:localization-catalog` and `pnpm run verify:localization-coverage`.

- [ ] **COMMIT:** `feat(codex-micro): add customizable device settings pane`

---

## Task 8: Integrate reversible runtime lighting/status output

**Files:**
- Create: `src/main/codex-micro/lighting-snapshot.ts`
- Create: `src/main/codex-micro/lighting-snapshot.test.ts`
- Modify: `src/main/codex-micro/coordinator.ts`
- Modify: `native/codex-micro/src/runtime_commands.rs`

**Produces:** A validated full snapshot containing ambient/key state plus six `thstatus` slots. It is converted only to captured `v.oai.rgbcfg`/`v.oai.thstatus` fields.

- [ ] **RED:** Tests require known-firmware-only writes, six bounded slot IDs, 24-bit RGB integers, 0–100 brightness, unchanged-snapshot no-op, and no resend after an indeterminate ack.

Run:

```bash
pnpm vitest run src/main/codex-micro/lighting-snapshot.test.ts src/main/codex-micro/coordinator.test.ts
cargo test --manifest-path native/codex-micro/Cargo.toml runtime_commands
```

Expected: missing snapshot implementation and command expectations.

- [ ] **GREEN:** Use only observed wire keys/effects. Do not name undocumented wire values with stronger semantic guarantees. Keep input event handling independent of command completion.

- [ ] **COMMIT:** `feat(codex-micro): add safe runtime status lighting`

---

## Task 9: Build and package the native sidecar

**Files:**
- Modify: `config/scripts/build-native-for-platform.mjs`
- Create: `config/scripts/build-codex-micro-sidecar.mjs`
- Create: `config/scripts/build-codex-micro-sidecar.test.mjs`
- Modify: `config/electron-builder.config.cjs`
- Modify: `config/scripts/verify-linux-glibc-floor.cjs`

macOS Phase 1 uses normal USB HID access through `hidapi` and does not change app entitlements. If physical validation proves that assumption false, stop as a packaging/security blocker rather than broadening entitlements inside this task.

- [ ] **RED:** Script test requires target-triple selection, `.exe` suffix on Windows, executable bit on Unix, deterministic resource destination, and inclusion in Linux floor scanning.

Run:

```bash
node --test config/scripts/build-codex-micro-sidecar.test.mjs
```

Expected: missing script.

- [ ] **GREEN:** Build the sidecar for the current target using Cargo, copy it to `native/codex-micro/dist/<platform>-<arch>/`, and add one platform-aware `extraResources` mapping. Extend native build without replacing existing Swift/PowerShell/launcher steps.

- [ ] **VERIFY:**

```bash
pnpm build:native
pnpm run verify:macos-entitlements
```

Run the real packaged Linux glibc check in CI or an Ubuntu 20.04-compatible builder; do not infer compliance from this newer host.

- [ ] **COMMIT:** `build(codex-micro): package the native USB sidecar`

---

## Task 10: End-to-end simulator and regression verification

**Files:**
- Create: `src/main/codex-micro/codex-micro-simulator.integration.test.ts`
- Modify: `docs/superpowers/specs/2026-07-27-codex-micro-design.md` to mark USB captures complete and link the fixture provenance/Phase 1 plan.

- [ ] **RED:** Integration test launches the actual Rust simulator through the actual TypeScript supervisor and requires known firmware → connected, unknown firmware → read-only, all proven controls emitted, optional output failure not blocking input, disconnect/reconnect recovery, snapshot dedupe, and no state-command retry.

Run:

```bash
pnpm vitest run src/main/codex-micro/codex-micro-simulator.integration.test.ts
```

Expected: integration timeout/failure before final wiring.

- [ ] **GREEN:** Add only missing wiring exposed by the integration test.

- [ ] **VERIFY:**

```bash
cargo test --manifest-path native/codex-micro/Cargo.toml
pnpm test
pnpm typecheck
pnpm lint
pnpm build:desktop
pnpm build:native
git diff --check
```

- [ ] **COMMIT:** `test(codex-micro): verify the USB vertical slice end to end`

---

## Task 11: Independent review and physical acceptance

**Review gate:** Codex independently reviews the full diff against `brittlestar`, the approved design, capture reports, and fixture provenance. Critical/Important findings are fixed with a failing regression test, then re-reviewed. Security review checks USB trust boundaries, subprocess environment, frame limits, redaction, and write gating.

**Physical target:** `vmc-m4-mini` with Codex Micro connected through Cynthion/pass-through as directed by Vincent.

Physical acceptance:

1. Feature is off by default; no sidecar remains running.
2. Enabling detects `303a:8360` and reports firmware `v0.4.1`.
3. Every AG/ACT/encoder control dispatches its selected existing Orca command once per intended gesture.
4. Mapping changes survive restart.
5. Runtime lighting responds when enabled and stops in read-only/disabled states.
6. Duplicate snapshots cause no visible extra write/flicker.
7. Unplug/replug restores state without losing input.
8. Ownership conflict and release/retry recover without stealing the device.
9. Diagnostics contain no serial/raw report.
10. Disabling releases the device for ChatGPT/vendor software.

Record the matrix and real command output in the draft PR body. Do not merge; Vincent reviews and publishes the final state.

---

## Later PRs / Explicit Phase 1 Non-goals

- BLE discovery/transport after a real BLE capture.
- Microphone and hands-free gestures.
- Radar-to-action mappings; Phase 1 only decodes radar safely.
- Provider-specific approve/decline/Fast/reasoning controls.
- Dynamic six-session slot projection and durable provider-session pins.
- Full per-key RGB/effect authoring beyond proven safe runtime snapshots.
- Battery/profile/layer UI beyond status display.
- Multiple simultaneous Codex Micro devices.
- Firmware/keymap/profile writes or firmware updates.
- Layers 2–6 customization.

Phase 1 is complete only when the simulator suite, full Orca checks, independent Codex review, and the physical `vmc-m4-mini` acceptance matrix are green.