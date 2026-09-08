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
  never become another host's generation.
- Serve only complete, content-addressed packages produced by the release
  build. Do not copy loose assets into a packaged Desktop installation.
- Never replace, delete, or copy cached generation assets manually. There is no
  activation file to edit: the single directory under `generations/` is the
  activation. Let the shell redownload, or install a corrected release.
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
| New package repeatedly terminates its WebView process                     | Native verified generation    | Stop the Desktop rollout; the shell has no earlier generation to fall back to |
| One host reports corrupt or unreadable cached assets                      | Host-scoped native cache      | The shell drops that cache and redownloads on the next page-load failure    |
| Package requires an unsupported bridge version                            | Desktop/native compatibility  | Restore a package compatible with the installed shell; do not force-open it |
| Pairing, encrypted connectivity, asset origin, cache, or bridge is broken | Native shell                  | Halt the store rollout and prepare a corrected native release               |
| Notification, deep-link, permission, audio, or picker fails               | Native shell                  | Halt the store rollout and prepare a corrected native release               |
| Desktop is unavailable but a healthy verified cache exists                | No rollback                   | Continue using the cache; defer refresh until the Desktop reconnects        |
| Desktop is unavailable and no verified cache exists                       | Connectivity/package delivery | Reconnect or switch hosts; cache recovery cannot manufacture a package      |

## Desktop Web-Package Incident

### Contain

1. Stop distributing the affected Desktop build through every active channel.
2. Record the Desktop version and commit, the affected package build prefix,
   installed shell version, bridge version, package source, and stable failure
   code.
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

The Desktop must stop serving the rejected build ID. The shell has no memory of
a bad build: it will download whatever Desktop currently serves, so containment
is entirely a Desktop-side responsibility.

### Expected client behavior

- A healthy cached interface remains usable while the Desktop is unavailable
  or a refresh fails.
- A newly opened package is not active until the native store has verified its
  manifest and every asset and renamed the staged tree into `generations/`.
- A WebView process loss restarts the view in place. There is no earlier
  generation to promote, so a package that keeps crashing keeps restarting.
- A page that fails to load makes the shell delete that host's cache and
  download the package again, once per host selection. A second failure leaves
  the notice on screen instead of downloading again.
- An unreachable Desktop leaves the shell in its offline state; the refresh
  resumes when the connection returns.

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
   cache-drop redownload, and the affected capability.
4. Verify the corrected shell against the active Desktop package and the oldest
   package still inside the supported compatibility window.
5. Resume a phased rollout only after the corrected build passes the final
   release-candidate gates.

A Desktop package rollback cannot repair native pairing, secure storage,
encrypted transport, WebView configuration, cache verification or activation,
bridge implementation, notifications, deep links, permissions, audio, or
pickers.

## What the User Sees

The shell has no recovery controls. Recovery is automatic and has exactly two
moves:

- A failed page load deletes the host's cached generation and downloads the
  package again. This happens once per host selection; a second failure leaves
  the notice on screen.
- A lost WebView process restarts the view in place.

Support can still ask the user to leave a broken host through the **Hosts**
button in the shell header, which is present whenever the hosted interface is
not showing.

The shell shows a plain-language notice plus an `Error: <code>` support line;
that code is the same stable failure code recorded in diagnostics.

Redownloading is not a Desktop rollback. If the Desktop still serves the bad
package, the client downloads the same bad package again.

## Diagnostics and Escalation

Ask the user to open **Connection Log** for the selected host and use
**Copy diagnostics**. The rollback record should contain:

- Orca Desktop version and commit.
- Mobile shell version, platform, device class, and store channel.
- Twelve-character package build prefix and bridge version.
- Package source (`verified-cache` or `desktop-refresh`) and package state.
- Stable failure code.
- The action attempted and whether the same result occurred after restart,
  reconnect, or host switch.

Do not request pairing credentials, endpoints, full build IDs, absolute paths,
repository content, filenames, terminal bytes, or WebView payloads. Escalate
any credential exposure, cross-host cache use, executable asset mismatch,
private-origin escape, or unauthorized capability call as a security incident
rather than a routine rollback.

## Release-Candidate Drills

Before production cutover, record iOS and Android evidence for:

1. WebView process loss restarting the view in place.
2. A failed page load dropping the host cache and redownloading once.
3. A corrupt cached generation refusing to open and being replaced by a
   verified redownload.
4. An interrupted download leaving no staged tree after a restart.
5. Incompatible bridge, disconnected Desktop, and pairing removal.
6. Bad Desktop package containment and a corrected Desktop package rollout.
7. Paused native store rollout and a corrected native release rehearsal.
8. Privacy review of the copied diagnostics and release evidence.

Repeat the drills on the exact store-signed final release candidate. Simulator
and emulator evidence does not close the physical-device or store-release
gates.
