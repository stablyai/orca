# Late browser registration replies restore retired renderer state

`createBrowserPageWebviewGuestSession` awaited `registerGuest` IPC and then wrote the returned guest ID into the renderer's persistent `registeredWebContentsIds` map. An explicit close could remove the webview and map entry before that reply arrived; a delayed success restored the retired entry. An older reply could also overwrite the ID of a replacement guest. Its follow-on callbacks could synchronize an obsolete annotation bridge or mutate recovery state after the listener session was disposed. Separately, recovery validation could issue repair IPC after its initial registration query outlived that owner.

The fix checks the existing recovery disposal state, current listener ref, persistent registry identity, and captured WebContents ID before accepting a reply or running those continuations. It makes no new registry and sends no late unregister IPC. A current hidden guest still accepts successful registration. When a persistent guest remounts, the new session's existing `validateAfterResume` path retries registration if the old reply was ignored. Current unsuccessful replies and current repair retain their prior behavior.

## Reproduce

With dependencies already installed:

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/browser-registration-reply-retention/reproduce.mjs
```

This runs the actual renderer session, recovery controller, and persistent guest registry against headless DOM fixtures and deferred IPC replies. The baseline reverses only the included production patch in memory. A temporary observer records map/callback counts after all replies settle. The script uses the shared process launcher, 512 MiB workers, a 60-second deadline, and temporary files removed in `finally`. No Orca window, native guest, or remote host is launched.

| After 1,000 explicit guest closes and delayed successful replies | Before | Fixed |
| ---------------------------------------------------------------- | -----: | ----: |
| Live webviews                                                    |      0 |     0 |
| Retained registration entries                                    |  1,000 |     0 |
| Late annotation synchronizations                                 |  1,000 |     0 |
| Unregister calls                                                 |  1,000 | 1,000 |

The baseline fails ten tests and passes six controls; fixed source passes all 16. Cases cover distinct closed IDs, replacement elements, a changed guest ID on the same element, a remount reusing the same element/ref, disposed and moved refs, registry removal before listener disposal, a throwing identity getter, hidden current guests, successful/inconclusive replies, and late versus current repair. The repair-completion case verifies that an old success cannot clear a newer guest's recovery error. All host-guest suites also pass: 196 tests across 23 files, including recovery, viewport, registry, worktree retention, and paintability. The web typecheck passes.

## Version and limits

Targeted reads of `v1.4.198` confirm the same unconditional registration setter, post-reply callbacks, post-query repair, and close-time map deletion. This establishes a renderer retaining path in the reported version, not that #19831 or #19768 exercised it. Each retained entry is a page ID and numeric guest ID. This proof does not show a surviving native browser process or explain gigabyte-scale memory growth. The independent main-process destroyed-guest callback retention has its own fix and proof.

The registration reply is the only production setter of `registeredWebContentsIds`; explicit close and replacement remove its key. Following callers found no second setter that could recreate this same metadata after removal. The annotation callback uses current page routing, which is why skipping a stale callback is necessary without issuing cleanup against a replacement.
