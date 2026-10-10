# Preserve an observed exit during explicit terminal close

An explicit close can receive the target daemon's physical EXIT, then fail its aggregate verification because another preserved daemon is unavailable. The close method used to invoke the fallback kill even though the runtime already held an `exited` verdict. That redundant request emitted a synthetic `-1`, replacing `operator_close` with `unknown/stop_unverified` and sending a second renderer exit notification.

The fix captures the stamped PTY incarnation before awaiting the stop. A false stop result is accepted only when the same incarnation remains current and the runtime already has an `exited` verdict. It does not create an exit certificate from an empty inventory or transport failure.

## Reproduce

From the checkout, with dependencies already installed:

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/terminal-close-observed-exit/reproduce.mjs /tmp/terminal-close-observed-exit.json
ORCA_BACKGROUND_LAUNCH=1 node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/main/runtime/terminal-close-observed-exit.test.ts
```

The script runs eight scenarios before and after the change, reversing only the new capture and guard for the before variant. It uses the actual runtime close method, runtime controller, daemon router, and two real daemon socket endpoints. The subprocess itself is controlled by the existing test harness. The script uses temporary configuration files, checks the expected outcomes, records source hashes, and removes its temporary directory. It does not install dependencies, launch a UI, or alter the checkout. `results.json` preserves the recorded result; use a separate output path when rerunning.

| Scenario                                                    | Before                                                                                      | After                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Target physical EXIT received; unrelated daemon unavailable | Close returns false; one redundant kill; cause overwritten; two renderer exit notifications | Close returns true; no redundant kill; `operator_close` preserved; one renderer exit notification |
| Healthy aggregate inventory, delayed physical EXIT          | Close succeeds                                                                              | Unchanged                                                                                         |
| Target socket paused; unrelated daemon unavailable          | Close remains unverifiable despite target's empty inventory                                 | Unchanged                                                                                         |
| Same stamped incarnation already exited                     | Redundant fallback kill                                                                     | Existing exit accepted                                                                            |
| Same raw ID registered with a newer incarnation             | Old certificate rejected                                                                    | Unchanged                                                                                         |
| Synthetic negative exit, no host exit certificate           | Close remains unverifiable                                                                  | Unchanged                                                                                         |
| Unstamped legacy session                                    | Certificate not reused                                                                      | Unchanged                                                                                         |
| Stop throws after exit                                      | Catch records unverifiable                                                                  | Unchanged                                                                                         |

In all socket scenarios, the physical provider event and runtime exit listener settle once. The fixed observed-exit case has no headless model or title tracker retained. This proof measures lifecycle behavior, not retained heap bytes.

## Dependency and incident limits

This change is stacked on [#21000](https://github.com/stablyai/orca/pull/21000), branch `np-oom-scan-daemon-late-exit`, and reuses its actual daemon socket fixture and late physical-exit reconciliation. #21000 fixes final DATA arriving after a synthetic exit. This change prevents a redundant synthetic exit after a physical exit has already been accepted. The before variant is the current checkout with this narrow guard reversed, not a pristine historical build.

The unconditional fallback and exit-cause assignment are present in the reported `v1.4.197` source (`orca-runtime-stop-explicitly-closed-tab-ptys.ts`, `orca-runtime-on-pty-exit.ts`). They explain a concrete way to get a failed close and `stop_unverified` despite a confirmed local exit. [#19018](https://github.com/stablyai/orca/issues/19018) does not establish that an unrelated preserved daemon was unavailable; this is a conditional explanation, not proof of the reporter's exact ordering.

Generic inventory remains fail-closed. Exact-owner verification across daemon generations is separate work. This change does not solve a thrown stop, SSH loss of contact, unstamped identities, or all same-ID shutdown races. A missing diagnostics row remains insufficient evidence of process death.
