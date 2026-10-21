# Destroyed browser guests retain main-process callbacks

An embedded browser guest's `destroyed` event called `cleanupGuestPolicyAttachment`. That removed its primary page-to-WebContents lookup but left four per-page cleanup callbacks that capture the destroyed WebContents wrapper, plus renderer/workspace/worktree/profile metadata. `unregisterAll` subsequently iterated only the now-empty primary lookup: three callback maps and the renderer/workspace metadata survived that cleanup too.

Renderer reload can destroy guests without each page sending explicit unregister IPC. A later close of a restored, unmounted page does not send that IPC either: `destroyPersistentWebview` returns early when its renderer registry has no guest. Explicit unregister correctly releases these resources; same-page re-registration also replaces its callbacks. The defect affects destroyed owners that do not take either path.

The fix routes destruction through the existing `unregisterGuest` with a guest-retirement reason only when that exact guest still owns the primary page ID. Already bound downloads retain their existing renderer routing until they settle; explicit page close still cancels them. Unregistered guests and popups retain policy-only cleanup. A stale callback cannot unregister a replacement. Normal renderer-process loss keeps its live WebContents and metadata for reload recovery; a fresh guest registration supplies its ownership metadata again. Shared browser sessions and sibling pages are untouched.

## Download lifetime correction

Review found that the initial fix treated guest destruction as logical page closure and canceled bound downloads. An exact-source before/after control confirmed that difference with an EventEmitter guest and controlled DownloadItem. Guest retirement now releases guest-owned callbacks while preserving ongoing page downloads, their destinations and cancel authorization. A retained numeric renderer route drains after the last download settles, provided no replacement guest, other download or newer routing owner needs it.

Nine additional controls cover progress and completion/error delivery, explicit close after guest destruction, multiple downloads, replacement guests/routing, repeated guest destruction and renderer loss. Together with four existing browser suites, 55 tests pass; Node typecheck and ordinary/anti-slop lint pass. These controls do not establish native Chromium download survival after destruction on each operating system. No download capacity or wire format changes.

## Reproduce

With dependencies already installed, run from the repository root:

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/browser-destroyed-guest-retention/reproduce.mjs
```

The script runs the actual manager and guest callback installers with EventEmitter WebContents fixtures. It removes only the destruction guard in memory for the baseline, then runs the same nine tests on the fixed source. A temporary test observer records actual map sizes before each assertion. It launches no Orca window or browser process, limits each worker to 512 MiB and each run to 60 seconds, uses the shared process launcher, and removes temporary files. Results include source hashes and runtime provenance.

| After 1,000 distinct guest destructions                                    | Before | Fixed |
| -------------------------------------------------------------------------- | -----: | ----: |
| Primary guest lookup                                                       |      0 |     0 |
| Each context-menu / grab-shortcut / app-shortcut / wheel cleanup map       |  1,000 |     0 |
| Each renderer / workspace / worktree / profile map                         |  1,000 |     0 |
| Policy cleanup map                                                         |      0 |     0 |
| Each context-menu / grab-shortcut / app-shortcut map after `unregisterAll` |  1,000 |     0 |
| Renderer and workspace maps after `unregisterAll`                          |  1,000 |     0 |

Baseline: six tests pass, three fail. Fixed: all nine pass. Controls cover explicit unregister, same-ID replacement with a captured old callback, popup and pre-registration destruction, renderer-process recovery, fresh guest registration, and two pages sharing one browser session profile. The selected existing browser-manager and offscreen lifecycle suites also passed: 64 tests across seven files including the new suite.

## Version and limits

Targeted source reads of `v1.4.198` confirm the same destroyed-event policy-only cleanup, map ownership, and `unregisterAll` omission. The executable comparison uses current production source; it does not launch the historical app. This is a retaining path present in the version reported by #19831/#19768. It does not establish that either incident followed this destruction sequence, or measure native memory retained by a destroyed WebContents. The 1,000 iterations measure retained callbacks and metadata, not 1,000 surviving Chromium processes or a gigabyte allocation.

Adjacent audit negatives: explicit page close removes the renderer guest registry and main registration; worktree switching deliberately parks guests under the existing hidden-worktree retention policy; offscreen creation is synchronously indexed with shutdown admission and exact-window teardown; client-hosted async page creation checks availability after acquisitions and cleans canceled owners. PDF capture rejects late disconnected-client completion, its stream buffers have a five-minute TTL, and existing screenshot commands have deadlines. No additional native screenshot hang or unbounded native-page acquisition was reproduced. The separate late renderer registration reply can restore small page-ID metadata after close; it is outside this main-process fix.
