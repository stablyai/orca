# Orca Mobile

React Native companion app for Orca. Monitor worktrees, view terminal output, and send commands from your phone.

Local development uses two processes:

- Orca desktop/Electron from the repo root. This hosts the mobile WebSocket RPC server on port `6768`.
- Expo Metro from `mobile/`. This serves the React Native app on port `8081`.

## Prerequisites

- Node.js 24+
- pnpm
- Xcode and/or Android Studio tooling for simulator or device builds
- Expo Go on your phone, or a development client build when native modules are needed
- Phone and desktop on the same LAN when testing a physical phone

## Start Desktop Orca

From the repository root:

```bash
pnpm install
pnpm dev
```

Confirm the mobile RPC server is listening:

```bash
lsof -nP -iTCP:6768 -sTCP:LISTEN
```

Restart `pnpm dev` after changing Electron main-process code. Metro hot reload only applies to the mobile JavaScript bundle.

## Start The Mobile App

```bash
cd mobile
pnpm install
pnpm start
```

Scan the Expo QR code with your phone's camera on iOS, or Expo Go on Android.

For a native dev-client build:

```bash
pnpm exec expo run:android
pnpm exec expo run:ios
pnpm start --dev-client
```

## Pair With Desktop Orca

1. Open Orca desktop.
2. Go to Settings > Mobile.
3. Scan the pairing QR code from the mobile app.
4. Confirm the mobile host endpoint is `ws://<desktop-ip>:6768`.

For the Android emulator, use `ws://10.0.2.2:6768`. For a physical phone, use the desktop LAN IP, for example `ws://192.168.0.179:6768`.

If the phone has a stale host entry, remove it from the app and pair again.

## Development Paths

### Android Phone

1. Install Expo Go from Google Play
2. Run `pnpm start`, scan QR with Expo Go
3. For native modules: `pnpm exec expo run:android`
4. Run with `pnpm start --dev-client`

### iOS Simulator

1. Install Xcode from the App Store
2. Run `pnpm start --ios` to open in iOS Simulator

## Physical Phone Debugging

The phone can be inspected through the connected device tooling:

```bash
orca snapshot --json
orca click --element @e3 --json
orca fill --element @e1 --value "ls" --json
orca screenshot --json
```

Use `snapshot` first to find the current element refs, then click/fill those refs. After mobile file edits, Metro usually hot reloads automatically, but navigating out of and back into the session screen can be useful because it re-runs `terminal.subscribe`.

## Terminal Streaming Repro Without A Phone

Use this when terminal output does not render on device and you need to split server streaming bugs from WebView/UI bugs:

```bash
cd mobile
ORCA_MOBILE_WS_URL=ws://127.0.0.1:6768 pnpm exec tsx scripts/test-subscribe.ts <deviceToken> <serverPublicKeyB64>
```

You can pass a worktree selector as the third argument:

```bash
pnpm exec tsx scripts/test-subscribe.ts <deviceToken> <serverPublicKeyB64> "id:<worktreeId>"
pnpm exec tsx scripts/test-subscribe.ts <deviceToken> <serverPublicKeyB64> "path:/absolute/worktree/path"
pnpm exec tsx scripts/test-subscribe.ts <deviceToken> <serverPublicKeyB64> "name:my-worktree"
```

The expected result includes:

```text
streamSawMarker: true
readSawMarker: true
```

If this repro fails, debug the desktop runtime/PTY path before the mobile WebView. If it passes but the phone is blank, debug the session screen or `TerminalWebView` readiness/queueing path.

## Terminal Color Repro Without A Phone

Use this when terminal colors disappear after switching tabs. Open a Claude Code terminal and at least one other terminal in the target worktree, then run:

```bash
cd mobile
ORCA_MOBILE_WS_URL=ws://127.0.0.1:6768 pnpm exec tsx scripts/repro-terminal-colors.ts \
  <deviceToken> <serverPublicKeyB64> "id:<worktreeId>"
```

The script captures `terminal.subscribe` snapshots in an A → B → A sequence and writes raw snapshots to `mobile/terminal-color-repro/`. If the two A snapshots have different `sgrColor` counts, the desktop snapshot changed during the switch. If they match, the ANSI color data is still present and the bug is in mobile replay/rendering.

## Validation

Run these checks before committing mobile terminal changes:

```bash
cd mobile
pnpm exec tsc --noEmit
pnpm lint
cd ..
pnpm typecheck:node
```

## Protocol Version Compatibility

Mobile and desktop talk over a versioned protocol. Because mobile updates lag desktop by 24-48h via the App Store, both sides exchange version numbers on `status.get` so a genuinely incompatible combo can hard-block instead of silently misbehaving.

Constants live in two files (Metro can't resolve outside `mobile/`):

- `src/shared/protocol-version.ts` — `DESKTOP_PROTOCOL_VERSION`, `MIN_COMPATIBLE_MOBILE_VERSION`
- `mobile/src/transport/protocol-version.ts` — `MOBILE_PROTOCOL_VERSION`, `MIN_COMPATIBLE_DESKTOP_VERSION`

Today all four are set so `evaluateCompat` always returns `{ kind: 'ok' }` — nothing blocks. The wire format is in place to flip a switch when needed.

### When to bump

Bump `DESKTOP_PROTOCOL_VERSION` (and the mobile mirror `MOBILE_PROTOCOL_VERSION` when relevant) for **breaking** changes:

- Removed RPC method or required parameter that mobile uses
- Changed meaning (units, nullability) of an existing field mobile reads
- Changed encryption, framing, or auth handshake

Do **not** bump for additive changes:

- New RPC methods
- New optional fields on existing methods
- New event types in `terminal.subscribe`

Set `MIN_COMPATIBLE_MOBILE_VERSION` (kill-switch) when desktop ships a change that requires a minimum mobile version to function safely. Same for `MIN_COMPATIBLE_DESKTOP_VERSION` from the mobile side.

When a verdict is `blocked`, `mobile/src/components/ProtocolBlockScreen.tsx` renders a screen pointing the user at either the App Store (mobile too old) or GitHub Releases (desktop too old).

To exercise the block screen locally: set `MIN_COMPATIBLE_DESKTOP_VERSION = 999` in `mobile/src/transport/protocol-version.ts`, rebuild, pair to any desktop. Revert before merging.

## Mock Server

Develop the mobile app without a running Orca desktop instance:

```bash
pnpm mock-server           # starts mock WebSocket server on port 6768
```

Connect from the app using endpoint `ws://localhost:6768` and token `mock-device-token`.

## Connecting to Real Orca

1. Start Orca desktop with WebSocket transport enabled
2. In Orca, go to Settings > Mobile and scan the QR code with this app
3. The QR encodes the connection endpoint, device token, and TLS fingerprint

## Project Structure

```
mobile/
├── app/                   # Expo Router screens (file-based routing)
│   ├── _layout.tsx        # Root layout with navigation stack
│   ├── index.tsx          # Home screen — paired hosts list
│   └── pair-scan.tsx      # QR code scanning screen
├── src/
│   ├── terminal/          # Terminal WebView and xterm bridge
│   └── transport/         # WebSocket RPC client
├── scripts/
│   ├── test-subscribe.ts  # Desktop streaming repro without a phone
│   └── mock-server.ts     # Standalone mock WebSocket server
└── assets/                # App icons and splash screen
```
