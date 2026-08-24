# Terminal session recovery catalog

> Live recovery update, 2026-08-23 14:12 MST: recovery-v2
> `1.4.189-adhoc.20260823204916` is installed, all 131 complete affected topologies in tracked
> worktrees survived the cutover, and one provider-backed affected Codex tab was recovered in
> place. This catalog intentionally remains a frozen-evidence artifact; current runtime results are
> recorded in
> `cutover-v2-20260823T140110MST/RECOVERY_V2_CUTOVER_STATUS.md`.

This catalog is derived only from the frozen evidence in `evidence/`. It did not query or modify the live Orca app, profile, runtime, PTYs, or process table.

## Recovery summary

| Measure | Count |
|---|---:|
| Incident terminal tabs | 158 |
| Worktrees | 61 |
| Pane PTYs represented by those tabs | 191 |
| Primary PTYs: unverifiable | 138 |
| Primary PTYs: exited | 20 |
| Surviving primary history directories | 138 |
| History bytes | 5100637 |
| Frozen-current unverifiable topologies already complete | 3 |
| Missing unverifiable layouts added to candidate | 135 |
| Missing unverifiable legacy tabs added | 135 |
| Missing unverifiable unified tabs added | 9 |
| Missing tab groups added | 3 |
| Exited terminal tabs receiving no restored records | 20 |

The incident set is the 158 terminal layout IDs present in `orca-data.json.bak.1` and absent from `orca-data.json.bak.0`. A primary PTY is **exited** only if its latest event, ordered by timestamp and then frozen log order, is `session-exited` or `session-killed`; all other outcomes are **unverifiable**. Loss of contact is never interpreted as exit.

## Offline merge policy

The candidate starts from the frozen current `evidence/profile/orca-data.json`. For each unverifiable primary PTY it adds only missing before-profile records: 135 layouts, 135 legacy tabs, 9 unified tabs, and 3 tab groups. Existing current layouts and tab records are never overwritten; existing group state stays authoritative and receives only missing tab IDs. No missing records are added for the 20 proven-exited primary PTYs, though any records already present in the frozen current base remain untouched.

Validation result: **PASS**. The candidate grows from 863 to 998 layouts. Full machine-readable checks and hashes are in `RECOVERY_MERGE_VALIDATION.json`.

The candidate is not ready for direct use while the affected hourly build is running. Before use: perform a controlled Orca shutdown, capture a fresh live-profile backup, and start a build with tri-state liveness protection. Only then compare the fresh shutdown profile with this frozen-base candidate and decide whether to regenerate or substitute it.

## Evidence limitations

- No frozen `orca terminal list` output is present, so the JSON catalog leaves runtime handles null. A profile PTY ID is recorded separately and is not claimed to be a live runtime handle.
- No frozen `ps` snapshot is present, so process-candidate arrays are empty. Daemon log `pid` values are daemon emitter PIDs, not agent-child PIDs.
- A historical `session-created` or `session-attached` event does not prove current liveness; it therefore remains unverifiable.
- Of the 138 unverifiable primary PTYs, only 5 have their latest frozen daemon event from PID `6835`; 133 have their latest event from other daemon PIDs. This provenance does not prove those sessions remained live, but it rules out treating loss of PID `6835` as sufficient evidence that the whole unverifiable set exited.
- `Not found in registered daemon adapters` is routing evidence, not an exit verdict. The catalog requires a latest `session-exited` or `session-killed` event before classifying a primary PTY as exited.
- Each JSON session includes all pane PTYs, latest daemon event provenance, terminal-history metadata and hashes, provider recovery metadata, current-profile presence, candidate disposition, and a recommended recovery action.

## Per-session index

| Worktree | Tab ID | Primary PTY suffix | Panes | Verdict | History | Provider records | Current layout | Candidate action |
|---|---|---|---:|---|---|---:|---|---|
| `orca-top-level-cleanup` | `7e00a32c-a6cb-4f1e-9f27-777f10ba2163` | `fa471831` | 1 | **exited** | no | 0 | missing | preserve-current-exited-records |
| `1.4.183-p0-orca-crashed-all-agent-sessions` | `5839876f-859d-48fa-ad8a-4aede2ea95b0` | `8804d1a3` | 1 | **exited** | no | 1 | missing | preserve-current-exited-records |
| `add-more-e2e-tests` | `a3440ae6-882a-4362-95f5-c58d5016ddbe` | `ba88e6c5` | 1 | **exited** | no | 1 | missing | preserve-current-exited-records |
| `add-starting-agent-from-tab-e2e` | `2a3a2338-1445-45ec-8598-13c019467109` | `31c4cb12` | 1 | **exited** | no | 1 | present | preserve-current-exited-records |
| `add-starting-agent-from-tab-e2e` | `46e4f9a1-0867-4dfe-be66-e683bdb5cdde` | `43f5e12a` | 1 | **exited** | no | 1 | present | preserve-current-exited-records |
| `add-starting-agent-from-tab-e2e` | `c8cc6933-c4f3-473f-a544-70bd3f43ee78` | `4ea40b01` | 1 | **exited** | no | 1 | present | preserve-current-exited-records |
| `add-starting-agent-from-tab-e2e` | `f853e0e5-15d7-4888-af9b-390e1d819fe9` | `8972c618` | 1 | **exited** | no | 0 | missing | exclude-proven-exited |
| `allow-create-automations-with-ai` | `271d789d-6db1-423b-a714-d74e91a111db` | `49fbac2f` | 2 | **exited** | no | 0 | missing | preserve-current-exited-records |
| `analytics` | `ae9b57fa-3351-4327-a726-94af04868e77` | `5fb657da` | 2 | **exited** | no | 1 | missing | preserve-current-exited-records |
| `audit-default-settings` | `fd0a28c0-ce62-438a-b13f-08dfc9a868de` | `55fddb5f` | 2 | **exited** | no | 1 | missing | preserve-current-exited-records |
| `auto-auto-pr-assignment-run-86-20260814T1645` | `bc077d77-7800-4aad-91c6-3ab0471b56de` | `b9b726f2` | 2 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-auto-pr-assignment-run-86-20260814T1645` | `cac7e5ca-96c8-4dd3-bd26-1c42e539940d` | `074c00d3` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260814T1500` | `bd3fce23-8552-44cf-bd6a-b6e0aeeb4f42` | `2c0c1f2c` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260814T2300` | `3c80f8b3-cded-44dd-9236-25a657dab47b` | `72fbd9e4` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260815T1900` | `1b7b2a04-0627-43c7-92b1-d66861b28455` | `ca76565c` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260815T1900` | `b2e2fccd-9b81-4632-b91c-067dd671b611` | `34e82ad0` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260815T1900` | `f7aaf80d-9522-4c93-b641-d9c0e34516e5` | `c88a58ad` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T1900` | `0fd88ccc-9dde-43e9-aff9-6301aa75d9b4` | `3867ab5d` | 2 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T1900` | `c7178099-e489-4bc2-b6e6-f866723a03f9` | `343c97dc` | 2 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T1900` | `eb2b6d01-3018-4733-a9ab-69357c1795bd` | `614960b9` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | `09d7a488-4e20-4229-a9fb-a176f71a9311` | `6bc4cece` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | `138ce7f3-cad3-40de-afa1-e6279977fbcc` | `fac0c631` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | `149d3580-bd7a-4815-af23-9906587bb716` | `593e9a00` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | `1f55d417-be78-4ea2-b9c6-d8d1348aea84` | `8298b45c` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | `3bd7cf1c-bf7a-4900-89d3-ab6d549a514f` | `2727bdb1` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | `45fb20d7-093e-4bc8-880f-852fe488f983` | `eb3b9fe2` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | `4cbc1a76-0265-42c0-8cb1-1742d512738e` | `e6430688` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | `50b5be53-de68-4a4a-bb66-0b41e63d2b83` | `d6499bd5` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | `5437e8b5-3003-4f18-8027-80e8b94d6634` | `1a32dbcd` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | `56a02156-5f07-4008-b32f-0abb086630fd` | `0232124a` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | `8630026e-0525-4c18-a8b5-5eb8b4c92f80` | `7f7126e5` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | `8d1c66d8-4f5f-4b4d-84f2-f0c9c30f006f` | `3921d7fb` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | `9f78616e-1a5c-4688-b5b8-2f2b76f768fd` | `1bc85db0` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | `a76c55c9-e879-4f92-ba24-906058b011e7` | `efca7e8b` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | `acba7889-fc0f-406a-b2ef-215a5ecd436f` | `b0fcff2e` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | `b019ccdd-f5cb-4468-a3cc-daf60a1cf439` | `fa5e2406` | 2 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | `bd0f896f-6c69-4668-a72b-1dc927f4bbc1` | `1a8a174c` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | `bee2ce09-9103-43a0-8802-e19b3d607eea` | `23423419` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | `c340f891-0215-441f-be38-d2bb8498fea3` | `4885350c` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | `c3b6fbef-2f24-4057-a148-8d2f8b0cf777` | `59e2e93c` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | `cc84b271-6b9b-4f9d-82af-02fc7fc48797` | `edf568c4` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | `d61ce87a-b9c9-4ffe-93b8-23d4eb0bccc1` | `837371b4` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | `e7b9457a-4759-44e3-9058-fa375e61ff92` | `6bae4f90` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | `fa56e660-455d-4ac5-a367-8481c1ce351c` | `d5016fa5` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260819T0300` | `05701a5e-d2a9-4002-bddf-e24a6b248e88` | `19ac9fc3` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260819T0300` | `63ac1f4e-4596-4858-bbfd-5e60ccc8217c` | `0a40db48` | 2 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260819T0300` | `8692ed46-447c-47b5-a68a-f3d7c9dcf6d9` | `9f7d856b` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260819T0300` | `ce89a3d7-5d76-4e0c-9696-42a63b61e82c` | `b7feadd3` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260819T1500` | `e522f804-bf30-42bc-a1ff-ae99cb1d9b36` | `c3e9dcbc` | 2 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260820T1900` | `036086d6-fdc4-42fd-92cb-78231b572075` | `22e20c9f` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260820T1900` | `064fe2f7-0030-4a3a-b998-d6a66660fd03` | `290ed235` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260820T1900` | `3325dda4-085e-45d2-a803-9aa406cf9db9` | `863608d1` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260820T1900` | `339f2a7a-5b4b-4f8e-b136-408792de069c` | `d84ba2c4` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260820T1900` | `33e38b02-b71f-437e-b10a-21d546275ff8` | `c79d5dbc` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260820T1900` | `44a6cdaf-eb1b-4b3d-babe-93939175930d` | `505bd5f9` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260820T1900` | `450e8103-9607-41b9-8dd6-ee033a36e9c5` | `e4ac2526` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260820T1900` | `5b025b35-c98d-4b66-b233-478b5df9437a` | `ede1ab8a` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260820T1900` | `689bec64-1482-44dc-a4f6-633bc4ed4283` | `c7849e0a` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260820T1900` | `90726d94-0fc5-4adc-b321-1dfd4f5f9027` | `701b0a50` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260820T1900` | `b5286573-3ac6-4724-9baa-374b2ceb6563` | `04e88198` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260820T1900` | `bae2dfc1-6d54-446e-9488-759aa8e3a670` | `a0c3f640` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260820T1900` | `eb7ae053-ba4f-48bb-a064-7a8ec67ee139` | `39848d1b` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260821T0500` | `2be24a99-bd69-4eea-aef6-e5f91a1b2976` | `66a64cb2` | 2 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260821T1622` | `4280f25e-44f9-46f7-a3b8-866b6056f20d` | `5334f289` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260821T1622` | `4c79f3fd-72c7-4842-9225-edfe1e66ac2e` | `02d0f9bb` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260821T1622` | `53d48771-8101-4e97-ad39-9ae23f20f6a9` | `8b0aa695` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260821T1622` | `5b859e30-dca0-43ad-9246-53c8338ae6c6` | `501dddb0` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260821T1622` | `a53310e5-268f-498a-b7ed-52dd7cb8fbcb` | `2d2f4519` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260821T1622` | `b28a6a9f-407a-4669-be9e-d145e0b68945` | `6187ebba` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260821T1622` | `c10c91f1-76e5-4170-a0cc-141cb97bb8a8` | `a29ba124` | 2 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260821T2300` | `2910a21a-7c02-44e2-b0ca-661c39866298` | `13b2d8a3` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260821T2300` | `6b19be54-3d68-42e6-8876-f962ae952c12` | `f2e1c169` | 2 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260822T0300` | `8958317c-91dd-4349-9bcd-3a98ec1c7ca1` | `0396191b` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260822T2300` | `26726cbb-f7b5-4035-8d07-6c9b41990e6b` | `e9af8bc5` | 2 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260823T0300` | `dcddf2fb-0971-4d43-ad03-fb5ce5a2cd61` | `a2dbb054` | 2 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-daily-agents-hot-topics-digest-gtm-run-7-20260814T1700` | `428bc398-11c0-4781-9b79-2ab03054dc81` | `37f05f5c` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-daily-prod-release-scan-run-11-20260815T1754` | `ba9d00f8-3f5b-493f-9319-94037dc10ee6` | `59091a79` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-daily-prod-release-scan-run-13-20260817T1740` | `59761048-ed6b-4590-b6ec-8417e7fd77a6` | `2bf19ea3` | 2 | **unverifiable** | yes | 2 | missing | restore-missing-topology |
| `auto-daily-prod-release-scan-run-13-20260817T1740` | `c5e12afc-4531-4d54-8035-68ed6d2e8026` | `2363fd5a` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-daily-prod-release-scan-run-13-20260817T1740` | `db740737-57bb-4700-8497-0780b54fb043` | `9ea3c2e7` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-daily-prod-release-scan-run-13-20260817T1740` | `ee01f0b4-a157-48d1-a305-53e7f48fecf1` | `1a405155` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-daily-prod-release-scan-run-14-20260818T1740` | `e35397a5-5cee-441d-baf0-57c014f14790` | `06c6bab4` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-daily-prod-release-scan-run-16-20260820T1708` | `6af9a99f-12f5-443d-90ab-134b8baebe48` | `845a4da1` | 2 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-daily-prod-release-scan-run-16-20260820T1708` | `c06ef3bb-2944-45bf-b8aa-64e49a514109` | `c2329e22` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-daily-prod-release-scan-run-16-20260820T1708` | `d169ec37-3ec4-4540-8af2-a89dfd02e506` | `d19e8f14` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-daily-prod-release-scan-run-16-20260820T1708` | `db39371f-27cb-4c08-a175-f43ae51aa53f` | `21553287` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-daily-prod-release-scan-run-16-20260820T1708` | `eaa5210e-0174-46fe-bbdf-94b5929b41f4` | `6b298232` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-daily-prod-release-scan-run-16-20260820T1708` | `f913ab34-7dbb-4582-8d75-e2822ccda52d` | `65b864bf` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-daily-prod-release-scan-run-18-20260821T1740` | `8478a4b5-4d01-4b0f-a1dc-0bf55993719e` | `782038ec` | 1 | **unverifiable** | yes | 1 | present | preserve-current-topology |
| `auto-daily-prod-release-scan-run-18-20260821T1740` | `bc221df1-fac5-48fa-a35b-0d3f2375945b` | `a313bcea` | 2 | **exited** | no | 0 | missing | exclude-proven-exited |
| `auto-daily-prod-release-scan-run-18-20260821T1740` | `d919ab75-fb15-4f21-9425-21e6c16794be` | `04230ccf` | 2 | **unverifiable** | yes | 1 | present | preserve-current-topology |
| `auto-daily-prod-release-scan-run-19-20260822T1740` | `237117d8-b14d-4edb-a56b-399d6f4ab0c9` | `6613c1d9` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-daily-prod-release-scan-run-20-20260823T1740` | `00e08298-f6f3-425b-9ee6-22fe7132f229` | `57026aac` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-daily-prod-release-scan-run-6-20260811T1700` | `190bcbca-c988-4b37-bcca-d1c8b6d7d7cd` | `69aa6e2f` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-daily-prod-release-scan-run-6-20260811T1700` | `2864af3e-6155-4901-b663-afb55ba43064` | `2acfc72b` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-daily-prod-release-scan-run-7-20260812T1700` | `869e32e7-6566-4ba5-adf2-9eda7b4494f8` | `34de7420` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-daily-prod-release-scan-run-7-20260812T1700` | `9728013f-aff4-4294-92ce-36afea103bac` | `9fb50f61` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-daily-prod-release-scan-run-7-20260812T1700` | `ab920a81-8c20-46cf-a32d-9bdcd5e2d9ae` | `7ec7c820` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-daily-prod-release-scan-run-8-20260813T1700` | `53484cef-73d2-4f33-a2ea-96e44aee2c72` | `0da91944` | 3 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-daily-prod-release-scan-run-8-20260813T1700` | `7c9afce8-f410-45c2-b3ea-f169c5304fb1` | `64f6db4a` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-daily-prod-release-scan-run-8-20260813T1700` | `f8e25869-400b-478f-9ad7-563cd165830a` | `db45412e` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-10-20260823T0200` | `d1d27580-d7be-437f-8fa5-951368151478` | `98a89cf0` | 2 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-10-20260823T0200` | `fae01383-5948-44e1-8e23-d7f5a800d1e8` | `0997b509` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-11-20260823T0700` | `19fd8026-8d74-4241-84f0-8feec88c2f93` | `824b1859` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-11-20260823T0700` | `2668697d-3b06-45a7-ada2-ff7772ac764e` | `dd1678cf` | 2 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-2-20260819T0200` | `05a1ca5c-d5e6-4a6a-910e-13c79b9ad769` | `3a7d2133` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-2-20260819T0200` | `8d2caa53-ba05-4495-bb5f-3cc00fa9d15d` | `0befdc75` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-2-20260819T0200` | `937c8488-57f4-4bbe-8264-b028e6c8bd1c` | `b5d80904` | 2 | **unverifiable** | yes | 2 | missing | restore-missing-topology |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-2-20260819T0200` | `9820d9bb-f4a9-4e20-86a0-92e583e9ce5a` | `de00197d` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-5-20260820T0700` | `29652a5a-2fd5-47ca-a286-a2eb9e90cca6` | `35cc8ecd` | 2 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-5-20260820T0700` | `3b15826a-a649-42e4-bb39-2cb3a66df945` | `1f90f984` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-5-20260820T0700` | `e15e1c2e-b031-47aa-af53-f686cbb21efd` | `6c4f82c3` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-6-20260821T0200` | `90b910a9-55d2-4912-a155-51d281aec183` | `e4d686e8` | 2 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-6-20260821T0200` | `be872a35-6422-4b3e-8a0f-9b4b4cff1a6b` | `de5a3cf2` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-7-20260821T0700` | `9d8a5da9-0189-45f2-bc3b-832384bdf0a7` | `eedea3aa` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-7-20260821T0700` | `e87ae76c-6fe3-40f9-9dd5-8f146b0971dd` | `8263332e` | 2 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-8-20260822T0200` | `6ed35091-30c4-4088-b1be-d6869408aa33` | `3d9b1dac` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-9-20260822T0700` | `d6d43b87-9d6b-4c48-87cc-641719ecab8e` | `a95190fc` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `being-able-to-select-parent-worktree-when-creating-worktree` | `d3df7002-ba01-4e10-ab50-5553480ad974` | `a8342e80` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `being-able-to-select-parent-worktree-when-creating-worktree` | `d7db5e13-d101-444e-bde3-513e689a05c5` | `e57e2dd1` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `close-tab-on-mobile-back-to-prev` | `96c97b5f-1301-426f-9873-beda6bbdd657` | `6684a1fc` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `close-tab-on-mobile-back-to-prev` | `bef02734-4073-4ad1-aee8-22b9b256e919` | `91aa4322` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `commit-now-takes-a-long-time` | `335c5789-42bb-4380-b164-7fc2bd60a21a` | `f01fe425` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `commit-now-takes-a-long-time` | `3b7657d0-ac7a-46bd-a85b-5c6fd25cf91e` | `23acb531` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `commit-now-takes-a-long-time` | `da97fd74-8b48-4a49-9327-4b2955c20a15` | `1d81bbec` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `create-scanning-issues` | `bd4aa329-3e5c-40e6-bdb1-d55a77b27552` | `fe3a15cb` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `create-ssh-worktree-error` | `242f0327-915a-4694-bf94-91c0b4cdea2b` | `9cc25c3c` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `create-ssh-worktree-error` | `24f63cd7-cd4a-4b81-a339-4f2eda115bac` | `b70d565b` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `create-ssh-worktree-error` | `7b261f3b-fc27-40b4-a0fe-573a1f76b79a` | `a2eba1ca` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `custom-agents` | `097c89c9-3ce5-4ec9-a6e2-744c33dddf0c` | `2c152915` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `custom-agents` | `8e5359bf-aa35-4930-a8d8-3ee82e308832` | `85065bfc` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `daemon-downgrade-recovery` | `fe005739-e157-4086-88d2-5867637e29b3` | `07c92549` | 2 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `default-child-workspace` | `02d3c458-c11d-4374-bab5-5f54de21dba6` | `752b0330` | 2 | **unverifiable** | yes | 2 | missing | restore-missing-topology |
| `deleting-skill` | `77ed8cdf-1731-40bf-a1cc-26a5b45a737b` | `b3d49597` | 2 | **unverifiable** | yes | 0 | present | preserve-current-topology |
| `discord-support` | `fc907521-5566-41d7-acfa-e166b1350974` | `70675bd9` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `display-failed-automations` | `5f407300-a1d8-4d13-9ab0-d9f32ae7ee66` | `e1547367` | 2 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `e2e-automation` | `4425945e-9c22-437c-9629-b8443d0fcfad` | `a93a2bba` | 2 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `e2e-automation` | `744bf23a-d4be-4570-92b2-87214a887c00` | `bde9cf3c` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `enterprise-governance` | `51d7aea7-3927-4703-9380-7ed8274e34d0` | `7ee5502d` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `extension-planning` | `8af94eca-4174-4c23-9182-c7581479f741` | `0cb31d71` | 2 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `fix-notes-send-name-send-targets-after-their-tab` | `5eb4ce7d-491a-44cb-9109-feeebe956a49` | `1b189bf4` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `fix-notes-send-name-send-targets-after-their-tab` | `96a2653c-ab9d-44ee-bf68-beb04f9d0c13` | `3b9fd0c0` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `fix-notes-send-name-send-targets-after-their-tab` | `dc663961-f9e6-46b5-8e84-4d6897914348` | `6e7c347f` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `pure-extract-orca-runtime` | `b42751ef-5273-440c-871e-ba6d1331111a` | `bb0ce93b` | 1 | **exited** | no | 0 | missing | exclude-proven-exited |
| `pure-extract-orca-runtime` | `cca690e8-4b3e-4d3b-8230-85117385425e` | `bc7e0f51` | 1 | **exited** | no | 1 | missing | exclude-proven-exited |
| `pure-extract-orca-runtime` | `e0f9711c-fa77-495c-b239-a58276d50142` | `48533547` | 1 | **exited** | no | 0 | missing | exclude-proven-exited |
| `split-pty-connection` | `d782e028-017b-4288-bd6a-b6c0b66fd086` | `183c573b` | 1 | **exited** | no | 1 | missing | exclude-proven-exited |
| `split-pty-connection` | `fe1b69c8-41d3-469a-b699-42a27729d5a4` | `f0265ed6` | 1 | **exited** | no | 1 | missing | exclude-proven-exited |
| `split-task-page` | `1f120487-cfc4-4d3e-ac64-08e6411b1ab0` | `7c525cae` | 1 | **exited** | no | 1 | missing | exclude-proven-exited |
| `split-task-page` | `a37b588d-1b79-4cb4-b87d-c03ece690c45` | `75ea0008` | 1 | **exited** | no | 0 | missing | exclude-proven-exited |
| `split-task-page` | `dd0f15df-e203-4e51-a43f-9be0d1117e52` | `d3cfd89c` | 1 | **exited** | no | 0 | missing | exclude-proven-exited |
| `split-task-page` | `f275d8ca-12a1-4044-9c86-37ed6de988d8` | `4042761c` | 1 | **exited** | no | 1 | missing | exclude-proven-exited |
| `sta-4062-folder-note-rollback` | `1a7bd257-37b1-4362-af23-a183518414e7` | `11818262` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `sta-4062-folder-note-rollback` | `e7dfc74c-f23f-48b5-9221-a19393ed24c4` | `98c13247` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `sta-4062-folder-note-rollback` | `f66fd01a-e071-4482-9bc3-b675039f3330` | `41a4a575` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `sta-4064-phantom-folder-note` | `33dd7abb-2862-4771-be6b-9708205323f6` | `c4d72e5c` | 2 | **unverifiable** | yes | 0 | missing | restore-missing-topology |
| `sta-4064-phantom-folder-note` | `aa128462-b739-4657-a9bd-931e51640b2c` | `4b2345f4` | 1 | **unverifiable** | yes | 1 | missing | restore-missing-topology |
| `sta-4064-phantom-folder-note` | `dd6cbd36-106b-4a97-85f0-8afbe458bed6` | `2effc0c4` | 1 | **unverifiable** | yes | 0 | missing | restore-missing-topology |

## Proven-exited sessions

These 20 primary PTYs receive no restored records in the offline candidate. Records already present in the frozen current base remain untouched. Do not attempt raw PTY attachment; use a recorded provider session when available.

- `48e366bb-2436-46a9-bb37-10ace25ada5f::/Users/jinjingliang/Documents/projects/orca-top-level-cleanup@@fa471831` — no provider recovery metadata in frozen evidence
- `48e366bb-2436-46a9-bb37-10ace25ada5f::/Users/jinjingliang/Documents/projects/orca/1.4.183-p0-orca-crashed-all-agent-sessions@@8804d1a3` — provider recovery metadata available
- `48e366bb-2436-46a9-bb37-10ace25ada5f::/Users/jinjingliang/Documents/projects/orca/add-more-e2e-tests@@ba88e6c5` — provider recovery metadata available
- `48e366bb-2436-46a9-bb37-10ace25ada5f::/Users/jinjingliang/Documents/projects/orca/add-starting-agent-from-tab-e2e@@31c4cb12` — provider recovery metadata available
- `48e366bb-2436-46a9-bb37-10ace25ada5f::/Users/jinjingliang/Documents/projects/orca/add-starting-agent-from-tab-e2e@@43f5e12a` — provider recovery metadata available
- `48e366bb-2436-46a9-bb37-10ace25ada5f::/Users/jinjingliang/Documents/projects/orca/add-starting-agent-from-tab-e2e@@4ea40b01` — provider recovery metadata available
- `48e366bb-2436-46a9-bb37-10ace25ada5f::/Users/jinjingliang/Documents/projects/orca/add-starting-agent-from-tab-e2e@@8972c618` — no provider recovery metadata in frozen evidence
- `48e366bb-2436-46a9-bb37-10ace25ada5f::/Users/jinjingliang/Documents/projects/orca/allow-create-automations-with-ai@@49fbac2f` — no provider recovery metadata in frozen evidence
- `48e366bb-2436-46a9-bb37-10ace25ada5f::/Users/jinjingliang/Documents/projects/orca/analytics@@5fb657da` — provider recovery metadata available
- `48e366bb-2436-46a9-bb37-10ace25ada5f::/Users/jinjingliang/Documents/projects/orca/audit-default-settings@@55fddb5f` — provider recovery metadata available
- `48e366bb-2436-46a9-bb37-10ace25ada5f::/Users/jinjingliang/Documents/projects/orca/auto-daily-prod-release-scan-run-18-20260821T1740@@a313bcea` — no provider recovery metadata in frozen evidence
- `48e366bb-2436-46a9-bb37-10ace25ada5f::/Users/jinjingliang/Documents/projects/orca/pure-extract-orca-runtime@@bb0ce93b` — no provider recovery metadata in frozen evidence
- `48e366bb-2436-46a9-bb37-10ace25ada5f::/Users/jinjingliang/Documents/projects/orca/pure-extract-orca-runtime@@bc7e0f51` — provider recovery metadata available
- `48e366bb-2436-46a9-bb37-10ace25ada5f::/Users/jinjingliang/Documents/projects/orca/pure-extract-orca-runtime@@48533547` — no provider recovery metadata in frozen evidence
- `48e366bb-2436-46a9-bb37-10ace25ada5f::/Users/jinjingliang/Documents/projects/orca/split-pty-connection@@183c573b` — provider recovery metadata available
- `48e366bb-2436-46a9-bb37-10ace25ada5f::/Users/jinjingliang/Documents/projects/orca/split-pty-connection@@f0265ed6` — provider recovery metadata available
- `48e366bb-2436-46a9-bb37-10ace25ada5f::/Users/jinjingliang/Documents/projects/orca/split-task-page@@7c525cae` — provider recovery metadata available
- `48e366bb-2436-46a9-bb37-10ace25ada5f::/Users/jinjingliang/Documents/projects/orca/split-task-page@@75ea0008` — no provider recovery metadata in frozen evidence
- `48e366bb-2436-46a9-bb37-10ace25ada5f::/Users/jinjingliang/Documents/projects/orca/split-task-page@@d3cfd89c` — no provider recovery metadata in frozen evidence
- `48e366bb-2436-46a9-bb37-10ace25ada5f::/Users/jinjingliang/Documents/projects/orca/split-task-page@@4042761c` — provider recovery metadata available

## Artifact map

- `RECOVERY_CATALOG.json`: authoritative per-session evidence and recommendations.
- `RECOVERY_CATALOG.md`: human-readable index and merge explanation.
- `orca-data.recovery-candidate.json`: offline candidate based on the frozen current profile.
- `RECOVERY_MERGE_VALIDATION.json`: merge invariants, counts, hashes, and cutover safety gate.
- `generate-recovery-artifacts.mjs`: deterministic generator; it reads only `evidence/`.
