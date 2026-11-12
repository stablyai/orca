# STA-8667 D3r refreeze: handover (work stopped mid-task)

Written 2026-11-12 when STA-8667 moved to Brennan. The D3r refreeze with the coordinator decisions was **started and
not finished**. This note says exactly where it stopped.

Scope of the work: design and harness only. No production code, no PR, no GitHub comments, no Slack. The harness
branch is never merged.

## The two decisions being applied

- **PD-1 = option C.** Selected cap 10 min, visible cap stays 60 min. Reason: the selected PR is the one the user is
  looking at, so short CI runs on it must be seen; the cost is about +15 spawns/h per window (about 51 vs 741 before,
  10 GHES rows; local measurement on the D3r harness with `EXP_CAP_SELECTED_MIN=10`). Visible transient runs going
  unseen is accepted and must be stated: bounded by the 60-min visible cap + 10 s + slot wait; the card keeps its last
  settled state.
- **PD-2 = keep the stuck-check ladder** and state it as an explicit exception in the §3.3 contract table.

## Where things are

| Thing | Location | State |
| --- | --- | --- |
| Frozen D3r doc, version 1 (before the decisions) | `docs/design/sta-8667-auto-polling-design-d3r.md`, sha256 `978ebb341e761efe8e0e4f70c801f603241b61acb3d8dbcf27a6e900ee36f071` | **Unchanged.** Still says 30 / 60 and lists PD-1 / PD-2 as open. Share link: https://share.onorca.dev/a/_HiJ-bwldoOt |
| Harness, last complete commit | `AmethystLiang/sta-8667-polling-harness` @ `51a148903433b01fb7a8064bf55550a4abca7fa9` | D3 caps 30 / 60. Complete and consistent with doc v1. Not touched. |
| Work in progress | branch `AmethystLiang/sta-8667-d3r-wip` (one commit on top of `51a1489`; this file is in it) | Harness partly moved to 10 / 60, see below. |
| Worktree | `~/Documents/projects/orca/sta-8667-auto-polling` (branch `AmethystLiang/sta-8667-auto-polling` @ `9f32c6d06dd`; harness in `src/main/github/__experiments__/`, untracked there; `docs/**` is git-ignored, so the doc was added to the WIP commit by force) | Same content as the WIP commit. |
| Earlier report, spec, copies | `~/.orca/bots/perf-manager-2/memory/sta-8667/d3r/` (`D3R-REPORT.md`, doc v1, harness at `51a1489`, local results v1), spec `../d3r-spec.md` | Not updated by this refreeze. Still version 1. |
| Local results v1 (30 / 60) | `docs/design/sta-8667-d3r-results/` (in the WIP commit) and, in the worktree only, `src/main/github/__experiments__/results/v1-30-60/` and `logs/v1-30-60/` (git-ignored) | Valid for the 30 / 60 setting only. |

What the recovery found at the start of this task: the previous worker left **nothing uncommitted**. Every harness
file in the worktree was identical to `51a1489` and the doc had the frozen sha256.

## Done in the refreeze (all in the WIP commit)

1. `policy-d3.ts`: `SELECTED_CAP_MS` is now 10 min. `setCaps` unchanged.
2. `polling-d2.experiment.test.ts`: default of `EXP_CAP_SELECTED_MIN` is now 10. The detection bounds are computed
   from the configured caps, so the start-selected bound becomes 610 s without further edits. Not yet confirmed by a
   run.
3. `policy-d3.probe.test.ts`: expects the ladder `1, 2, 4, 8, 10, 10, …` and the default caps `[10, 60]`; the D3 caps
   (30 / 60) are checked in the same test as a named comparison through `setCaps(30, 60)`.
4. `specs3r.txt` (now 96 lines, was 94) and `specs3r-local.txt` (now 47, was 45). The `-sel10` lines would now
   duplicate the default, so they were replaced by `-sel30` lines (`EXP_CAP_SELECTED_MIN=30`, the D3 caps as the
   named comparison): `detect-desk-after-n10-sel30`, `capcost-ghes-n10-sel30`, `capcost-ghes-n50-sel30`, and new
   `detect-serve-after-n14-c2-sel30`, `capcost-serve-n14-c2-sel30`; locally `local-detect-desk-after-n10-8h-sel30`,
   `local-detect-serve-after-n14-c2-8h-sel30`, `capcost-ghes-n10-sel30`, `capcost-serve-n14-c2-sel30`.
5. The 4 probe files were rerun on the new policy: **4 files, 17 tests, all pass** (`logs-probes.txt` in the worktree,
   2026-11-12 15:35 local, node v26.10.0, vitest 5.0.5). This is the only run made on the 10 / 60 policy.

## Not done

1. **Local determinism list not rerun.** No scenario has run with the 10-min default. `local-digests.txt` still holds
   the 30 / 60 digests and is marked STALE in its header. Rule G against it would fail for every "after" scenario.
2. **`RUN.md` not updated.** It still says caps 30 / 60, "45 small scenarios, 28 of them twice", "94 scenarios",
   "143 PASS", and names `-sel10` in the F and H rows. New counts: 47 local, 29 of them in the rerun filter, 96 in
   the full list.
3. **`verdict3r.py` not changed.** Intended and not written: a check that an "after" scenario without a `-sel` /
   `-vis` suffix has `config.capSelectedMin == 10` and `config.capVisibleMin == 60`, so a run on the wrong commit is
   caught.
4. **Design doc not edited at all.** To do: constants, the §3.3 contract table (start on the selected row within
   610 s + slot wait; stuck ladder as a stated exception; visible transient runs stated as accepted), cost tables,
   every figure that depended on the 30-min selected cap with a label (measured locally / modelled), a "Decisions
   PD-1/PD-2" section, §15 pass rules, and the reviewer's name: **Eng - Reviewer** (was Eng - Neil).
5. No new harness commit on `AmethystLiang/sta-8667-polling-harness`, no new doc sha256, share link not updated,
   memory copies not replaced (when replacing, keep doc v1 there as `d3r-v1`).
6. m4-air rerun not started.

## A cheap consistency check for whoever reruns the local list

The harness is deterministic and the old list already ran both settings, so the new digests are predictable. These
are expectations, not results:

| New scenario (10 / 60 default) | Should equal the v1 digest of | v1 `spawnDigest` |
| --- | --- | --- |
| `ghes-desk-after-n10-focused` | `capcost-ghes-n10-sel10` | `085fa1bc3b1e731285f681bbb4053e8f81bb843f66d6147bbc8d075b89b8424c` |
| `local-detect-desk-after-n10-8h` | `local-detect-desk-after-n10-8h-sel10` | `d6c7b4faf61723b2d9dcda768e8dd4df6784a20a833a1f136b501cf6aad2bc6c` |
| `capcost-ghes-n10-sel30` | `ghes-desk-after-n10-focused` | `613613754cacbdfbd5943173ffbfcb091c36f0ede9f7d9a1ccd4247350bb9d21` |
| `local-detect-desk-after-n10-8h-sel30` | `local-detect-desk-after-n10-8h` | `6366ce7942c9dc39f8c958641acbeccbc4e5f91c0847a04a89c9d7f376b0c67a` |
| `local-detect-serve-after-n14-c2-8h-sel30` | `local-detect-serve-after-n14-c2-8h` | `b85047b5883a586cac3cd5e3060793c05b982277c171711772cb15534def5afe` |
| `capcost-serve-n14-c2-sel30` | `serve-after-n14-c2` | `121a887142ee451c4bb047f9376bc3aa63b4554544d3c7ed82216e44856e925b` |

`-vis30`, `-vis20`, `-sel15`, `-sel5`, `-sel10-vis20` and every "before" / old-client line should keep their v1
digests. All v1 digests: `docs/design/sta-8667-d3r-results/` and `git show 51a1489:src/main/github/__experiments__/local-digests.txt`.

## How to run the harness (from the repository root)

Full instructions are in `src/main/github/__experiments__/RUN.md` (still the 30 / 60 wording, see "Not done" 2).

```sh
E=src/main/github/__experiments__
# probes: 4 files, 17 tests
EXP_OUT_DIR=$E/results VITE_CONFIG_NATIVE_IGNORE_WARNING=true npx vitest run --config config/vitest.config.ts \
  $E/gate-lanes.probe.test.ts $E/scheduler-d3.probe.test.ts $E/policy-d3.probe.test.ts $E/rate-limit-d3.probe.test.ts 2>&1 | tee $E/logs-probes.txt
# local determinism list (authoring Mac: parallel 2 at most; no N=50/200, no 24 h runs there)
OUT_SUBDIR=local  $E/run-specs.sh "$PWD/$E/specs3r-local.txt" 2
OUT_SUBDIR=local2 $E/run-specs.sh "$PWD/$E/specs3r-local.txt" 2 '^(local-detect-|lanes-|cancel-)'
python3 $E/verdict3r.py $E/results/local --rerun $E/results/local2 | tee verdict-local.txt
# regenerate local-digests.txt from results/local (one "<name> <determinism.spawnDigest>" line per JSON), then
python3 $E/verdict3r.py $E/results/local --rerun $E/results/local2 --digests $E/local-digests.txt
```

Wall time on the authoring Mac for v1: 37-60 s per scenario at parallel 2 (the machine's load average was 66 when
this work stopped, so expect more).

The m4-air block of `D3R-REPORT.md` stays valid in shape for the new commit; change the SHA, and note the list is 96
scenarios and the determinism gate 47 + 29.

## Next steps

1. Finish the refreeze: "Not done" items 1-5, in that order (run first, then write the doc from the new numbers).
2. m4-air rerun of the full list on the new harness commit (probes, determinism gate, 96 scenarios, three reruns,
   `verdict3r.py`).
3. Eng - Reviewer design review of D3 (round 3 of 4).
4. Implement.

## File sha256 at the WIP commit (`src/main/github/__experiments__/`)

```
5c45d14449fe5e39b335bb533318278a5ec700beb14672207c3614410223bf60  gate-d3.ts
3bf47e88454fce54cf0fe0d0a5d24d8185d7ca6f111fffd2caf39d54fcb66003  gate-lanes.probe.test.ts
10991023045bc3c80c1530697140db9e9886dfb85ff6a6ad74e03118f23b0c9f  policy-d3.probe.test.ts   (changed)
4cc92016947b1782c59852ea01135d6cd2718d1fc78d8d8144e935f75da7833d  policy-d3.ts              (changed)
80c3e14a98cd2597738b4d97a40157f6ccf5b2870aca49b0a47b2279dba946ff  polling-cost.experiment.test.ts
69799db6f96f2ed6191647360c63b82e26402f966a954df734e7c3ba06990c10  polling-d2.experiment.test.ts (changed)
bc8a2cb6cd294793275312ab413b8e6ce8deef940b303a1618d8a65db59a8c7a  rate-limit-d3.probe.test.ts
4685190159987701f9f81c9c15e7526bb83eafa0ba43fef595cb65e4ca5e4a8a  rate-limit-d3.ts
bab4308d877d0de403f6655b8edb0ed6bd257fd27cd6b3e29fcee5cc657d9edd  scheduler-d3.probe.test.ts
9cb1ce015076b19d7dd05c38e826563021392bf822dfed8dc07a00a17d2592bd  scheduler-patches.ts
c4728435d9948839885b6e4215d5dc036214ca4f56790cb6270d2be767bb82a7  specs3r.txt               (changed)
c669447ca6e0a9601f8a3c424cd949033384cec6d2e73523da5b8464798d1db8  specs3r-local.txt         (changed)
e9d5365bf14a49aab9fe0a50428714db69291e5b6c58bb8e819026cde8acd193  local-digests.txt         (STALE header added)
632825aa0c656f739447e6052a948db1bb593a0b79c6d94811d5d64d5c40de92  run-specs.sh
3ee402bf0f15bf8644c39eccb23c7a4ef686319ea1187c475dcc37de20797293  table3.py
870233d3b7bbe2516fd26ee4989efbd19f459ca80c604d8e80570497a51fbcc4  verdict3r.py
dca64fe5ef0ce23e3ca675a40cf8385de5f609e19701b6864b28048351b26645  RUN.md                    (not yet updated)
```
