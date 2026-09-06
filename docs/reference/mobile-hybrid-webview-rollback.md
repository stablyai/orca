# Mobile Hybrid WebView Rollback and Recovery

This runbook covers production rollback for Orca's Desktop-served React Native
Web package and the store-installed mobile shell. It does not replace the final
release-candidate rollback drills.

See the
[hybrid architecture reference](./mobile-hybrid-webview-architecture.md) for
the package, trust, cache, bridge, compatibility, privacy, and support
boundaries used by this runbook.

## Safety Invariants

- Treat Desktop web-package rollback and native-shell rollback as separate
  operations. A web package cannot repair pairing, encrypted transport, the
  private asset origin, native cache code, the capability bridge, permissions,
  notifications, audio, or pickers.
- Keep package activation host-scoped. A package from one paired Desktop must
  never become another host's active or previous generation.
- Serve only complete, content-addressed packages produced by the release
  build. Do not copy loose assets into a packaged Desktop installation.
- Never edit `activation.json` or replace, delete, or copy generation assets
  manually. Use the native recovery controls or install a corrected release.
- Never collect pairing credentials, endpoints, absolute cache paths, full
  build IDs, filenames, terminal content, or page payloads for rollback
  diagnosis.
- The dedicated hybrid candidate has no native workspace fallback. A
  native-shell defect requires halting rollout and shipping a corrected,
  higher-version store build.

## Choose the Rollback Boundary

| Symptom                                                                   | Boundary                      | First action                                                                |
| ------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| Workspace UI regression follows one Desktop version                       | Desktop web package           | Stop that Desktop rollout and restore known-good package content            |
| New package times out or repeatedly terminates its WebView process        | Native verified generation    | Let automatic recovery promote the previous verified generation             |
| One host reports corrupt or unreadable cached assets                      | Host-scoped native cache      | Use **Reset** and redownload from an authenticated paired Desktop           |
| Package requires an unsupported bridge version                            | Desktop/native compatibility  | Restore a package compatible with the installed shell; do not force-open it |
| Pairing, encrypted connectivity, asset origin, cache, or bridge is broken | Native shell                  | Halt the store rollout and prepare a corrected native release               |
| Notification, deep-link, permission, audio, picker, or recovery UI fails  | Native shell                  | Halt the store rollout and prepare a corrected native release               |
| Desktop is unavailable but a healthy verified cache exists                | No rollback                   | Continue using the cache; defer refresh until the Desktop reconnects        |
| Desktop is unavailable and no verified cache exists                       | Connectivity/package delivery | Reconnect or switch hosts; cache recovery cannot manufacture a package      |

## Desktop Web-Package Incident

### Contain

1. Stop distributing the affected Desktop build through every active channel.
2. Record the Desktop version and commit, the affected package build prefix,
   installed shell version, bridge version, package source, health state,
   recovery count, and stable failure code.
3. Determine whether the failure follows the Desktop package across otherwise
   healthy shells. If native-owned behavior is failing, use the native-shell
   procedure instead.
4. Preserve the release artifact and privacy-safe diagnostics needed to
   reproduce the failure. Do not ask users to expose cache contents.

### Restore known-good content

1. Select a known-good Desktop commit whose mobile package supports the
   installed shell bridge.
2. Produce a corrected, higher-version Desktop release containing either the
   exact known-good package source or a reviewed fix.
3. Run the normal package build and verification commands. The manifest and
   every asset must verify before the Desktop serves either package RPC.
4. Confirm the packaged Desktop contains the expected manifest. Exact restored
   content may reproduce its prior build ID; any package or manifest change
   must produce a different content-addressed build ID.
5. Test a device with the bad generation active and another with only a healthy
   cached generation before resuming the Desktop rollout.

The Desktop must stop serving the rejected build ID. The mobile process keeps
bad build IDs rejected only for its current host session; reconnecting or
restarting must not make an affected Desktop safe.

### Expected client behavior

- A healthy cached interface remains usable while the Desktop is unavailable
  or a refresh fails.
- A newly opened package is not active until the native store verifies its
  manifest and assets and the page reaches the health boundary.
- A health timeout or third WebView process loss inside the crash window
  attempts to promote the compatible verified previous generation.
- **Use last version** promotes the verified previous generation and removes
  the failed generation from the rollback position.
- **Reset** closes the current package session, removes only the selected
  paired host's cache, and requires a verified redownload.
- An implicit cold open may replace an invalid active generation with a
  compatible verified previous generation. An explicit build open fails
  closed.

## Native-Shell or Store-Release Incident

### Contain

1. Pause every phased or staged store rollout that includes the affected native
   build.
2. Disable promotion to additional tracks or audiences and preserve the signed
   release artifact.
3. In the ordinary native-default build only, direct affected users to the
   retained native workspace route when it is safe. This step does not apply to
   the dedicated hybrid candidate, where every `/h/...` workspace route
   redirects to `/hybrid` and no native workspace fallback exists. Do not direct
   users through a broken pairing, credential, or recovery boundary.
4. Classify whether cached generations remain trustworthy under the affected
   shell. If the native verifier, origin, activation, or bridge is suspect,
   treat the cache as untrusted until a corrected shell revalidates it.

App stores do not provide a reliable remote downgrade for devices that already
installed a bad binary. Store rollout controls limit additional exposure; a
corrected, higher-version native release repairs installed clients.

### Correct

1. Fix the native-owned boundary and preserve the exact bridge compatibility
   policy. An incompatible protocol version must ship natively before a Desktop
   package requires it.
2. Build, sign, and submit a corrected native version through the normal store
   release process.
3. Verify native pairing, authenticated connectivity, package verification,
   cached and fresh open, private-origin isolation, bridge compatibility,
   automatic and manual recovery, and the affected capability.
4. Verify the corrected shell against the active Desktop package and the oldest
   package still inside the supported compatibility window.
5. Resume a phased rollout only after the corrected build passes the final
   release-candidate gates.

A Desktop package rollback cannot repair native pairing, secure storage,
encrypted transport, WebView configuration, cache verification or activation,
bridge implementation, notifications, deep links, permissions, audio, pickers,
or native recovery UI.

## User Recovery Controls

Use the least destructive control that addresses the observed failure:

The recovery UI promotes **Retry** as the single primary button and demotes the
remaining controls to text links, so support must name them by these labels:

- **Retry** asks the authenticated Desktop for its current package again. Use it
  after connectivity or Desktop package delivery is corrected.
- **Use last version** switches to the verified prior generation for the
  selected host. Use it for a newly activated functional regression or repeated
  process failure when the previous action is available.
- **Reset** removes the selected host's verified generations and forces a
  redownload. Use it for host-scoped corruption or when support explicitly
  needs to eliminate cached-package state.
- **Switch hosts** leaves the affected paired Desktop without changing another
  host's cache or credentials.

The shell shows a plain-language notice plus an `Error: <code>` support line;
that code is the same stable failure code recorded in diagnostics.

Cache clearing is not a Desktop rollback. If the Desktop still serves the bad
package, a cleared client downloads the same bad package again.

## Diagnostics and Escalation

Ask the user to open **Connection Log** for the selected host and use
**Copy diagnostics**. The rollback record should contain:

- Orca Desktop version and commit.
- Mobile shell version, platform, device class, and store channel.
- Twelve-character package build prefix and bridge version.
- Package source (`verified-cache` or `desktop-refresh`), package state, and
  health state.
- Recovery count and stable failure code.
- The action attempted and whether the same result occurred after restart,
  reconnect, or host switch.

Do not request pairing credentials, endpoints, full build IDs, absolute paths,
repository content, filenames, terminal bytes, or WebView payloads. Escalate
any credential exposure, cross-host cache use, executable asset mismatch,
private-origin escape, or unauthorized capability call as a security incident
rather than a routine rollback.

## Release-Candidate Drills

Before production cutover, record iOS and Android evidence for:

1. Readiness timeout and three-process-loss automatic recovery.
2. Manual **Use last version** recovery.
3. **Reset** followed by an authenticated verified redownload.
4. Corrupt active generation with compatible previous-generation fallback.
5. Incompatible bridge, disconnected Desktop, pairing removal, and WebView
   process loss.
6. Bad Desktop package containment and a corrected Desktop package rollout.
7. Paused native store rollout and a corrected native release rehearsal.
8. Privacy review of the copied diagnostics and release evidence.

Repeat the drills on the exact store-signed final release candidate. Simulator
and emulator evidence does not close the physical-device or store-release
gates.
