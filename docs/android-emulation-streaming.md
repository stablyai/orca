# Android Emulation — Live Pane Streaming (scaffolding + wiring)

The Android **control** path (device list, boot, tap/type/buttons/rotate/exec,
install/launch/permissions/ax/logcat) is complete and unit-tested. This document
covers the **live H.264 video pane** (scrcpy + WebCodecs), which is built as
scaffolding: the pure pieces are unit-tested, and the integration is **UNVERIFIED
— it needs the Android SDK, a running AVD, the bundled `scrcpy-server.jar`, and
Electron's WebCodecs runtime to validate.**

## What is built (committed)

| Module | Tested | Notes |
|---|---|---|
| `android/scrcpy-control-protocol.ts` | ✅ unit | Byte-exact control encoders (touch/key/text/back). |
| `android/scrcpy-video-frame-parser.ts` | ✅ unit | scrcpy v2.4 codec-meta + frame-header parsing. |
| `android/scrcpy-server-deploy.ts` | ✅ unit | push / forward / server-start arg builders. |
| `android/scrcpy-stream-session.ts` | ⚠️ unverified | Owns the server process + video/control sockets. |
| `emulator/scrcpy-video-registry.ts` | ✅ unit | Pub/sub bridging a session to renderer subscribers. |
| `ipc/emulator-video-stream.ts` | registration tested | `emulator:videoStream*` IPC; registered in `register-core-handlers`. |
| `emulator-pane/use-emulator-video-stream.ts` | ⚠️ unverified | WebCodecs `VideoDecoder` → `<canvas>`. |

## Remaining wiring (do on hardware, then validate)

### 1. Bundle `scrcpy-server.jar`

Download the **v2.4** server jar from the scrcpy releases (must match
`SCRCPY_SERVER_VERSION` in `scrcpy-server-deploy.ts`) and add it as a packaged
resource, mirroring how `serve-sim` is bundled:

- Place it at `resources/scrcpy/scrcpy-server.jar`.
- Add the resource to `config/electron-builder.config.cjs` (and, if needed,
  `config/packaged-runtime-node-modules.cjs`).
- Add a `resolveScrcpyServerJar(): string | null` that checks
  `process.resourcesPath/scrcpy/scrcpy-server.jar` then a dev fallback — model it
  on `resolveServeSimExecutable()` in `serve-sim-execution.ts`.

### 2. Wire `AndroidEmulatorBackend.startSession`

Replace the current "streaming not yet wired" throw with session creation that
feeds the registry. Keep a `createStreamSession` option so unit tests inject a
fake (real `ScrcpyStreamSession.start` does socket I/O). Sketch:

```ts
async startSession(deviceId: string): Promise<EmulatorSessionInfo> {
  const serial = await this.ensureBooted(deviceId)
  const jar = resolveScrcpyServerJar()
  if (!jar) {
    throw new EmulatorError('emulator_helper_failed', 'scrcpy-server.jar not bundled (see docs/android-emulation-streaming.md).')
  }
  const session = await (this.createStreamSession ?? ScrcpyStreamSession.start)(
    { runner: this.runner, sdk: this.requireSdk(), serial, localJarPath: jar, maxSize: 1024 },
    {
      onMeta: (meta) => scrcpyVideoRegistry.pushMeta(serial, meta),
      onFrame: (f) => scrcpyVideoRegistry.pushFrame(serial, { config: f.config, keyFrame: f.keyFrame, pts: String(f.pts), bytes: toArrayBuffer(f.data) }),
      onError: () => scrcpyVideoRegistry.stop(serial),
      onClose: () => scrcpyVideoRegistry.stop(serial)
    }
  )
  scrcpyVideoRegistry.register(serial, () => session.close())
  this.streamSessions.set(serial, session)
  return { deviceUdid: serial, streamUrl: `scrcpy://${serial}`, wsUrl: '', streamCodec: 'h264' }
}
```

Also make `stopHelperForDevice(serial)` call `scrcpyVideoRegistry.stop(serial)`
and close the stored session. (Splitting these into a small
`android-stream-session-starter.ts` keeps `AndroidEmulatorBackend` under the
300-line cap.)

### 3. Low-latency input via the scrcpy control socket (optional refinement)

Input already works via `adb shell input`. For smooth multi-touch, when a live
session exists, route `tap`/`gesture` through `session.sendControl(...)` using the
encoders in `scrcpy-control-protocol.ts` (convert normalized coords →
device pixels with `android-input-mapping`, then `encodeInjectTouchEvent`).

### 4. Preload + pane

- **Preload** (`src/preload/...` emulator API): add `startVideoStream`,
  `stopVideoStream`, `onVideoStreamMeta`, `onVideoStreamFrame` wrapping the
  `emulator:videoStream*` channels (mirror the existing `startFrameStream` etc.).
- **Pane** (`emulator-screen-stream-content.tsx`): when
  `session.streamCodec === 'h264'`, render the `<canvas>` from
  `useEmulatorVideoStream(deviceId, enabled)` instead of the MJPEG `<img>`.
- **Hardware buttons** (`emulator-phone-hardware-buttons.tsx`): add Android
  variants (Back, Home, Recents, Power, Volume) selected by backend kind, per
  `docs/STYLEGUIDE.md`.

### 5. Validate on hardware

```sh
pnpm build:cli
# boot an AVD (Android Studio or `emulator @<avd>`), then:
orca-dev emulator devices --json          # see the device
orca-dev emulator tap 0.5 0.8 --device <serial>   # control works today
# after wiring §2/§4: open the emulator pane and confirm the live frame + taps.
```

## Risks to validate first

- **WebCodecs H.264 in Electron**: confirm `VideoDecoder.isConfigSupported({ codec: 'avc1.640028' })`. If unsupported, fall back to a wasm decoder (Broadway/tinyh264) or a main-process H.264→JPEG transcode into the existing MJPEG channel — neither changes the backend interface (it advertises the codec).
- **scrcpy server protocol/version**: the option set + handshake in
  `scrcpy-server-deploy.ts` / `scrcpy-stream-session.ts` are pinned to v2.4 and
  must match the bundled jar.
- **Annex-B vs avcC**: the renderer configures the decoder without a description
  (Annex-B). If frames don't decode, extract the avcC from the config packet.
