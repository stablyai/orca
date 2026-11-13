# STA-13482 handover (to Brennan)

## Status

- **Done:** root cause, before numbers, and a design ready for D1 review (`design.md`). **Not started:** the code change (no implementation was written), the D1 review, and the real-app before/after.
- Base: `origin/main` @ 75823710787 (2026-11-12). Main does not fix this.
- Model used: Opus 5.5 (claude-opus-5-5), high effort.

## Files here

| file                                                      | what                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `design.md`                                               | Root cause (R1–R3), before numbers (probe cost on this M4Air, harness scenarios, field split), proposed fix (F1–F3), alternatives, what would disprove it, and measurements still to do                                                                                                                                                                 |
| `agent-model-catalog-probe-frequency.harness.test.ts.txt` | Harness: the real `createAgentModelCatalogService` and store, fake probes at measured per-agent costs, a fake clock. It counts probes per `+` open and per hour. To run, copy it to `src/main/native-chat/agent-model-catalog/zz-probe-frequency.harness.test.ts` and run `pnpm test <path> --maxWorkers=1 --silent=false`. Delete the copy afterwards. |
| `before-harness.json`                                     | Raw harness output on main 75823710787                                                                                                                                                                                                                                                                                                                  |

## Findings, in short

- Every non-saved-only `agentSession.modelCatalog` read calls `demand()` and probes when the store says the catalog is due. Probes are already deduped per agent per open. **Frequency is the issue:**
  - **R1:** Claude and Codex lists go stale after 2 minutes (`agent-model-catalog-entry-lifetime.ts`). In the field that is 166 of 206 spans over 13 hours.
  - **R2:** opencode 2.x, opencode2 and omp keep a separate catalog per worktree (`catalogFolder()`), so each new worktree costs a full ACP session boot. opencode2 is the most expensive probe: 6.4 s median, 19.1 s max in the field.
  - **R3:** the discovery span starts before the 2-slot admission semaphore, so its duration includes queue time.
- Harness, 1 hour at one `+` every 4 minutes across 3 worktrees: 65 probes and 103 s of probe time. Expected after F1+F2: about 25 probes and about 37 s.

## Proposed fix (see `design.md` §3)

- **F1:** Claude and Codex `resolve()` stamp the executable and the account config file (`realpath` plus `stat`). A changed stamp marks the entry due. Drop their 2-minute TTL to the shared 10 minutes.
- **F2:** `catalogFolder()` keys by folder only when `workspaceMayOverrideDefaultModel()` finds project model config. Add `.opencode/plugin(s)` to that detector.
- **F3:** add a `queuedMs` attribute to the span, or start the span after admission.

## Open questions

1. D1 has not reviewed the design yet. Scope is undecided: F1+F2+F3 in one PR, or F1+F3 first. The field split supports F1 as the main lever and F2 for opencode2.
2. Whether F2's detector covers everything that can add models in a project folder. OpenCode plugins are covered by the proposed addition; anything else?
3. Whether a 10-minute backstop is acceptable to the #30107 owners. With F1, CLI updates show on the next open, which is faster than today.

## Next steps

1. Get D1 on `design.md`.
2. Implement. The test policy in AGENTS.md applies: add only tests that fail when the change is reverted. Candidates:
   - a changed stamp marks the entry due;
   - a worktree with no project config shares the account list;
   - a worktree with config keeps its own list.
3. Re-run the harness after the change. Then measure the real app before and after on an isolated dev rig (`ORCA_DEV_USER_DATA_PATH`, CDP, hidden window): count spans per `+` open and time until the menu's model lists settle, with no load and under load.
4. Open the PR against stablyai/orca main.
