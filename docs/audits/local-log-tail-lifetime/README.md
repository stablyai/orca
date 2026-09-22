# Local log-tail watchers outliving their renderer

Main can receive a log-tail subscription, await path authorization, and finish installing its native watcher after the requesting renderer has gone away. Previously, the destroyed listener was registered only after authorization. Installed watchers also survived a renderer crash or a new document loaded into the same WebContents. The map retained each watcher and its sender callback; callbacks suppressed notifications to destroyed senders without releasing resources. This handler is present in `v1.4.198`.

The fix gives each sender one owner using the existing `abortWhenRendererGone` policy: destruction, renderer process loss, or committed document navigation closes its live watches and invalidates pending authorization. Same-document and canceled navigation preserve the owner. For a reused subscription ID, the latest pending request wins. Each pending subscription has an identity token; old completions and old watcher errors cannot replace or close newer subscriptions. Failed authorization preserves an existing installed watch. The last pending/live release removes all owner listeners.

This is a reproduced native-handle and small metadata leak. Watchers do not retain file-content chunks. It does not establish the input frequency or memory scale in [#19768](https://github.com/stablyai/orca/issues/19768) or [#19831](https://github.com/stablyai/orca/issues/19831).

## Reproduce

From the repository root with existing dependencies:

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/local-log-tail-lifetime/reproduce.mjs
```

The script runs the actual IPC handlers against temporary files, real `fs.watch` handles, controlled authorization promises, and EventEmitter senders. The existing IPC tests use watcher doubles to deliver an error from a retired watcher. No Electron window, real user log, process inventory, or network request is used. Test cleanup releases all watchers.

The baseline reverses only `fix.patch` in a temporary Vite transform. Working sources remain unchanged; source hashes and exact failed cases are recorded in `results.json`. Child test runners use the shared cross-platform process runner.

| Version             | Passed | Failed |
| ------------------- | -----: | -----: |
| Before lifetime fix |      9 |     10 |
| With lifetime fix   |     19 |      0 |

The twenty-owner case retained twenty native watcher owners before the fix and zero afterward. The broader cases cover destruction during authorization, active-plus-pending replacement, process loss/navigation, failed replacement, explicit stop, idle listener disposal, superseded success/error, and failed native installation. Ordinary tab cancellation already waited for start before stop; that behavior remains covered by the renderer hook tests.

Additional validation: Node typecheck, direct lint, and the existing renderer-lifetime and local-log-tail hook suites. This endpoint only watches renderer-authorized local logs. SSH/paired-runtime execution ownership and wire schemas do not change; the local editor eligibility check already excludes runtime-environment files. Folder workspaces follow the existing path authorization policy.
