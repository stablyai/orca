# SSH connection routes

This Expo module opens an app-owned local SSH forward for Orca Mobile. It does not
run a remote shell, install Orca, or use a device-wide VPN. The existing Orca
WebSocket, pairing token, pinned public key and encrypted RPC run inside the forward.

The Go engine is shared by Android and iOS. Kotlin and Swift expose `create`,
`probe`, `open` and `close`; all network work runs off the JavaScript thread.
Creating the native handle synchronously before opening it allows cancellation
even during DNS, SSH negotiation or authentication. Expo Go cannot load this module.

## Build prerequisites

- Node 24 and pnpm, as used by the repository.
- Go 1.27.1 (the module requires Go 1.27). `ORCA_GO_BINARY` can point to a Go binary.
- Android: Android Studio or the standalone Android command-line tools, JDK 17,
  SDK Platform 36, Build Tools 36.0.0, platform
  tools, and NDK 27.1.12297006 (the versions pinned by React Native 0.83).
  Set `ANDROID_HOME` to the SDK directory and `ANDROID_NDK_HOME` to that NDK.
- iOS: macOS, full Xcode with the iOS SDK, selected using `xcode-select`, and CocoaPods.
  A physical iPhone build also needs a development signing team and Developer Mode.

Android can be built on Linux without a desktop environment. Install the SDK
packages above and CMake 3.22.1 with the Android SDK manager. An x86_64 emulator
with KVM can exercise the same native module before testing an ARM64 phone.

From `mobile/`, after installing the repository and mobile dependencies:

```sh
pnpm install --frozen-lockfile

# Android
pnpm build:ssh:android
pnpm exec expo run:android --device

# iOS
pnpm build:ssh:ios
pnpm exec expo run:ios --device
```

The build script pins gomobile/gobind to the versions recorded in `engine/go.mod`.
It generates ignored native artifacts, not committed binaries. Rebuild the engine
after changing Go sources. Android consumes its Java classes and JNI libraries
directly because an Android library cannot embed a transitive local AAR. Release
shrinking keeps the generated JNI bindings. The Android linker explicitly aligns
the library for 16 KB memory pages with NDK r27. iOS consumes the generated XCFramework.

CI/EAS must provision these tools and run the matching `build:ssh:*` command before
the native build. Ordinary JavaScript dependency installation does not build Go.
Native build failures must not be interpreted as successful device support.

## Use

1. Run the Orca server and obtain an Orca mobile-compatible pairing code.
2. In the phone's pairing screen choose **Connect to a server through SSH**, or
   choose **Connect through SSH** after opening a pairing link.
3. Paste the pairing code and enter the SSH hostname, port, username and the Orca
   port on the remote machine. The forwarding destination is always `127.0.0.1` on
   that SSH host, regardless of the advertised address in the pairing code.
4. Enter an independently verified OpenSSH SHA256 host-key fingerprint, or fetch
   it and compare it with the server before explicitly trusting it.
5. Enter a password or import/paste a private key, with a passphrase if encrypted.
   Choose **Test and save connection**.

Existing hosts expose the same form from **Edit host → Connect through SSH**.
Reverting to a direct connection is explicit. A configured SSH route does not race
LAN, discovered addresses or Orca Relay. Pairing credentials and endpoint identity
remain unchanged; the temporary phone-local listening port is never saved.

## Ownership and security

- `ConnectionRouteProvider.open(endpoint, signal)` prepares a route lease;
  `close()` releases it. The socket factory owns one lease per WebSocket attempt.
  Timeout, cancellation, disconnect, authentication refusal and stale opens retire it.
- The forward listens only on `127.0.0.1`, on an OS-assigned port. It admits at most
  eight simultaneous sockets and sixteen native tunnel handles per module.
- Host-key verification happens before SSH authentication. Probing never sends
  credentials. A changed fingerprint fails closed and requires an explicit edit.
- Passwords/private keys/passphrases are chunked into secure-store entries. Host
  metadata stores only a credential reference. A journal tracks incomplete and
  superseded credentials for cleanup after removal and on the next app launch.
- Credentials are not placed in pairing codes, navigation parameters, native
  error strings, RPC payloads or AsyncStorage. An imported key's temporary cache
  copy is removed after reading it.
- Server state stays on the Orca server. Losing SSH connectivity never asserts
  that an agent or terminal process has exited.

## Initial scope and limitations

One SSH hop to a running Orca server, Android/iOS native clients, password or
private-key authentication, and the server's plain `ws://` endpoint carried inside
SSH and Orca E2EE. WSS is rejected because dialing a rewritten loopback URL would
change TLS hostname verification. No insecure certificate bypass is provided.

ProxyJump, arbitrary forwarding destinations, SSH config import, SSH agents,
hardware keys, keyboard-interactive/2FA, remote server provisioning and desktop
integration are outside this first implementation. The route interface permits
additional transports without changing RPC. Background execution is subject to
the phone OS; reconnect is expected when the app resumes, not an indefinitely
running background SSH service.

## Verification

```sh
# Go engine: actual SSH handshakes, authentication and binary forwarding
cd modules/orca-ssh-tunnel/engine
go test -race ./...
```

Mobile tests cover route cancellation/timeouts, late leases, reconnects, request
delivery ambiguity, host-key refusal, credential chunking, and pairing without
relay fallback. Physical-device acceptance still needs to cover both platforms:

- Password and encrypted-key pairing against a server unreachable directly.
- Initial trust, changed host key, wrong password/passphrase, revoked Orca token,
  and server-side `AllowTcpForwarding no`.
- Terminal input/output, file operations and other RPC through the saved route.
- Cancel during connection, retry, app restart, host editing/removal, and multiple hosts.
- Screen lock/unlock, background/foreground, Wi-Fi/cellular transitions and server restart.
- Release builds (including Android shrinking), not only development clients.
