# Architecture

The HarmonyOS client keeps a native ArkTS shell around the desktop-provided React mobile bundle. It does not modify the desktop RPC server or the iOS/Android application.

## Data flow

1. PairScan parses a desktop offer, pins its public key and completes E2EE v2 authentication. Non-secret host metadata is stored in preferences; credentials use Asset Store.
2. HostSession owns one physical WebSocket client per attempt, bounded handshakes/requests, a single liveness probe and reconnect timer.
3. ShellScreen downloads the manifest and assets, validates paths/size/hash, then renders only approved bundle resources under a local origin.
4. BridgeHost forwards requests/subscriptions with protected envelope fields, persists allowlisted page state per host and coordinates page/native navigation.
5. NativeDevice owns clipboard access, bounded staged media and the PCM ring for one document. It releases audio/media on disposal; backgrounding cancels capture, including a start awaiting permission.
6. AgentWatch observes agent transitions. LocalNotifier checks preferences at publish time and attaches a WantAgent route to local notifications.

## Compatibility

The connection currently uses the direct endpoint in the offer; automatic relay transport selection is not implemented. RPC envelopes preserve `executionHost`, but remote-server behavior still needs device acceptance against the paired desktop. Reconnect creates a new bridge generation and reloads the reported route. Mutating RPCs are never automatically replayed after an ambiguous timeout.

The vendored TweetNaCl module installs HarmonyOS secure randomness. SHA256/HMAC/HKDF are implemented in ArkTS and checked against published vectors. The web shell is served by the paired desktop, so desktop/mobile protocol changes must be tested together.

Prototype diagnostic pages remain under `pages/Spike*` and are reachable through the development tools entry. They are not a production acceptance substitute. Huawei push, screencast and on-device speech remain outside this prototype.
