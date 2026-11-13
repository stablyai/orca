# STA-13482: why model-list probes run so often, and the fix (design for D1)

- Base: `origin/main` @ 75823710787 (fetched 2026-11-12 23:0x PT). Main does **not** fix this: no catalog-freshness change has landed since the 1.4.258 field build.
- Model: Opus 5.5 (claude-opus-5-5), high effort.
- Artifacts (in this worktree): `.context/perf/sta-13482/` (`design.md`, `agent-model-catalog-probe-frequency.harness.test.ts.txt`, `before-harness.json`).

## 1. Root cause

Each `agentModelCatalog.discovery` span is one **listing probe**: Orca starts the agent's CLI the same way a chat would and reads its model list.

| agent                        | what one probe does                                                                                                 | `modelDiscovery` |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------- |
| claude                       | runs `claude` in stream-json and sends `initialize`, model list and `get_settings` control requests                 | own probe        |
| codex                        | runs `codex app-server`, then a paged `model/list` call                                                             | own probe        |
| opencode 2.x, opencode2, omp | runs `<agent> acp`, then `initialize`, `session/new` (in the chat folder), reads the models and deletes the session | `session`        |
| grok                         | runs `grok acp`, then `initialize`                                                                                  | `initialize`     |

There is no cheaper path. OpenCode 2.x rejects `--verbose` and its command listing leaves out providers that report late. OMP's CLI listing includes disabled models. Claude has no list command. So **cost per probe is fixed, and the only lever is how often probes run.**

### What triggers a probe

Every model-list read that isn't saved-only calls `catalog.demand()` (`structured-agent-session-options-read.ts:143`). That joins or starts a refresh, and the refresh probes when `store.probeDue(fingerprint)` is true. Callers:

1. **New-tab `+` menu**: on every open, one read per enabled agent (`use-agent-launch-picker-inventory.ts` → `agent-launch-picker-acquisition.ts`), at most 2 at a time. A waiting read follows if a listing is still running.
2. **Chat model picker** (`use-host-model-catalog-upgrade.ts`), **Settings → agent model** (`use-agent-settings-model-catalog.ts`), **new-worktree chat options** (`use-pending-native-chat-options.ts`) and mobile pickers: the same reads, so the same freshness rules apply.
3. **Startup prewarm** (`agent-model-catalog-prewarm.ts`): one read per used agent that isn't folder-scoped.

Concurrent reads are already deduped: one refresh per request key, and one in-flight listing per fingerprint (`store.refreshes`). In the harness, the menu's demand, read and follow-up waiting read for one agent produce exactly 1 probe. **The problem isn't duplicate probes. It's the freshness rules:**

- **R1: Claude/Codex lists go stale after 2 minutes.** `agentModelCatalogEntryIsStale` uses `2 * 60_000` for `independentAgentModelCatalog` (claude, codex) and 10 minutes for everyone else. #30107 picked 2 minutes so the picker would notice in-place CLI updates. The result: **any `+` open more than 2 minutes after the last one probes Claude and Codex again.** Hydrated Claude/Codex entries are always due after a restart (`attachPersistence`).
- **R2: Folder-scoped agents probe once per worktree.** For `listsInChatFolder` agents (opencode 2.x, opencode2, omp: session discovery), `catalogFolder()` puts the folder in the fingerprint. **Every worktree is its own catalog with its own 10-minute lifetime, and each cold one costs a full ACP session boot**, even when the worktree has no project model config and its list matches every other worktree's.
- **R3: The span overstates probe cost.** It starts _before_ the 2-slot admission semaphore (`agent-model-catalog-lister.ts:171`), so its duration includes time queued behind other agents' probes. Field spans of 15–19 s on a loaded Mac are mostly queue time plus CPU contention, not one probe.

The `+` menu rows themselves don't wait on probes. They render from the saved list (or the built-in fallback), and each agent's model list fills in when its read settles. Users see a model list that keeps loading, plus 2–5 CLI processes started on every open. On a loaded machine that contention is what makes the menu feel slow.

## 2. Before numbers

### Probe cost (no-load control: this M4Air, installed Orca 1.4.258, real probes from `main.trace.ndjson*`, 2026-11-06..12, 50 spans)

| agent                   | n   | median  | p90  | max  |
| ----------------------- | --- | ------- | ---- | ---- |
| claude                  | 14  | 1317 ms | 1675 | 3084 |
| codex                   | 19  | 988 ms  | 1402 | 1844 |
| grok                    | 8   | 897 ms  | 2032 | 2601 |
| opencode (2.x, session) | 4   | 1713 ms | 1802 | 1886 |
| omp (session)           | 1   | 2521 ms | –    | –    |

Field (Jinjing, 1.4.258-team, loaded Mac, 21:16–23:05 PT, as relayed by the coordinator): 42 discovery spans in about 110 minutes, **about 23 per hour, 141 s total (about 77 s per hour), max 19.1 s**. The ticket reporter's table shows the same shape: opencode2 has a 2.4 s median and claude a 1.6 s median.

### Probes per `+` open and per hour (harness: the real `createAgentModelCatalogService` and store, fake probes taking the medians above, fake clock; 5 agents; `before-harness.json`)

| scenario                                            | probes                                                             | probe time           | time until every row's models settle |
| --------------------------------------------------- | ------------------------------------------------------------------ | -------------------- | ------------------------------------ |
| first `+` after restart                             | 5                                                                  | 7.4 s                | 4.0 s (2 slots)                      |
| reopen after 30 s                                   | 0                                                                  | 0                    | 0                                    |
| reopen after 3 min                                  | **2** (claude, codex)                                              | 2.3 s                | 1.3 s                                |
| open in another worktree 30 s later                 | **2** (opencode, omp)                                              | 4.2 s                | 2.5 s                                |
| reopen after 11 min                                 | 5                                                                  | 7.4 s                | 4.0 s                                |
| **1 hour: one `+` every 4 min, across 3 worktrees** | **65 per hour** (claude 15, codex 15, opencode 15, omp 15, grok 5) | **102.6 s per hour** | 3.5 s per open                       |

The field rate (23 per hour) sits inside this model's range for lighter use: fewer opens or fewer folder-scoped agents.

### Field split (relayed by the coordinator; Jinjing's 1.4.258-team build, loaded Mac, 2026-11-12 10:20–23:22 PT, 13.0 h, 206 discovery spans)

| agent     | n   | per hour | median | max    | total |
| --------- | --- | -------- | ------ | ------ | ----- |
| claude    | 91  | 7.0      | 1.4 s  | 11.0 s | 196 s |
| codex     | 75  | 5.8      | 1.1 s  | 7.1 s  | 109 s |
| grok      | 18  | 1.4      | 4.5 s  | 8.9 s  | 91 s  |
| opencode2 | 18  | 1.4      | 6.4 s  | 19.1 s | 135 s |
| pi        | 4   | 0.3      | 0.7 s  | 3.7 s  | 6 s   |

Claude and Codex re-probe every 2–8 minutes all day; that is R1, and it accounts for 166 of the 206 spans. Grok and opencode2 probe together in bursts every 10–40 minutes. opencode2 is the most expensive probe (6.4 s median, 19.1 s max). This confirms F1 as the main lever and F2 for opencode2.

## 3. Design (smallest coherent fix)

Freshness should be **change-driven, with one backstop TTL**, not a short timer.

**F1: Detect Claude/Codex install and config changes; drop the 2-minute TTL.**

- Add an optional `installStamp?: string` to `AgentModelCatalogResolvedProbe`. The Claude and Codex `resolve()` functions already know the resolved `command` and the account home. Each fills the stamp from `realpath` plus `stat` (size, mtimeMs, ino) of the executable and of the account config file (`<configDir>/settings.json` for Claude, `<CODEX_HOME>/config.toml` for Codex). Missing files stamp as missing. The cost is 2–3 async `stat` calls in a step that already runs on every read.
- `resolveAgentModelCatalogScope` passes the stamp to the store (`store.observeInstall(fingerprint, stamp)`). A stamp that differs from the last one seen marks that fingerprint due. The **last good list keeps showing** while the new one is fetched, the same path a TTL expiry takes, so nothing flashes to the fallback.
- `agentModelCatalogEntryIsStale`: claude and codex use the shared `AGENT_MODEL_CATALOG_FRESH_MS` (10 minutes). The incomplete-listing rule and the `partialAttempts` 2-minute backoff stay as they are.
- Effect: a CLI update or config edit now shows on the **next** picker open, faster than today's up to 2 minutes. Background re-probing of Claude/Codex drops from 2-minute to 10-minute intervals.

**F2: Worktrees without project model config share one listing for folder-scoped agents.**

- `catalogFolder()` is the single owner of folder keying for both refreshes and live chat listings. It returns the folder only when `workspaceMayOverrideDefaultModel()` says the folder's project layers can change models. That detector already exists, parses `opencode.json`/`.opencode/*`/`.omp/*`, and already runs on every refresh for `keepDefault`. Otherwise it returns the shared account key.
- The probe still runs in the requesting folder: the lister gets `workspacePath` separately from the key. Session discovery still has a real chat folder.
- Adding project config to a worktree flips that folder to its own key and lists there. That is correct invalidation, and it comes for free.
- Close one detector gap so sharing stays safe: treat `.opencode/plugin` and `.opencode/plugins` as code folders (plugins can register providers).
- Effect: a cold worktree no longer costs a session boot when it carries no model config.

**F3 (2 lines, telemetry): add a `queuedMs` attribute to `agentModelCatalog.discovery`, or start the span after admission,** so after-fix numbers measure probes rather than queueing.

### Expected after (same harness scenario, verified in step 2)

- 1-hour scenario: **65 → about 25 probes per hour; about 103 s → about 37 s of probe time.** That is 5 agents × about 5 per hour at the 10-minute backstop.
- Reopen after 3 min: 2 → 0. Another worktree: 2 → 0 (no project config).
- A CLI update or `settings.json`/`config.toml` edit: 1 probe on the next open.

### What this does not regress

- **STA-10857 (picker never refreshes):** reads still demand a refresh. Change signals plus the 10-minute backstop still re-probe, and the invalidation subscriptions are unchanged.
- **STA-14118 (transient probe failures):** the failure TTL and `partialAttempts` are untouched.
- **STA-8645 (catalog store failures have no eviction):** untouched. F1's stamp map is bounded to `AGENT_MODEL_CATALOG_MAX_ENTRIES` and evicted with its entries.
- The launch-proof rule ("saved lists are display-only until this process discovers") is unchanged.
- Remote hosts: stamps are computed where the probe runs (the local main process or the remote `orcad`). WSL and non-native scopes keep the base fingerprint, as today.
- Folder workspaces: `catalogFolder` already takes plain folders.

**User-visible?** No new UI. Model lists refresh on change instead of every 2 minutes. I don't think this needs UX Designer review; flag it if you disagree.

## 4. Alternatives considered

1. **Only raise the Claude/Codex TTL to 10 minutes (one line).** Smallest, but an in-place CLI update could take up to 10 minutes to show, which is what #30107 picked 2 minutes to avoid. F1 makes updates show sooner than today.
2. **Make `+` menu reads saved-only (never probe on open).** Brings back STA-10857: lists only refresh from chats or startup.
3. **A longer backstop (30–60 minutes) with stamps for every agent.** ACP agents would need command resolution outside the probe. That's more code; a possible follow-up if 25 per hour is still too many.
4. **Key folder catalogs by a hash of the project config's contents.** More precise than F2, but adds new keying and reads in the live-listing path. F2 reuses the existing detector.
5. **Trust hydrated entries across restart when the stamp matches.** Saves about 2 startup probes, but weakens the deliberate "verify in this process" launch proof. Out of scope.

## 5. What would disprove this

- **Field probes don't follow R1/R2.** The field trace should show claude+codex pairs at ≥2-minute gaps lining up with picker opens, and opencode2/omp per new worktree. If spans cluster without picker reads, another trigger dominates: `expireLaunchScopes` from shell-env refresh or host launch-env pushes, or `subscribeModelMenuInvalidation` firing. **Ask: the raw field `main.trace.ndjson` (agent and timestamp per span) to confirm the per-agent split.**
- **After the fix, the harness's 1-hour scenario doesn't drop to ≤ about 25 probes**, or a real-app rig still counts more than 0 probes on a reopen within 10 minutes.
- **A worktree with model-affecting project config shares the account list.** That would mean a detector gap; F2 tests cover it.

## 6. Measurements still to do (step 2)

- Real app before and after on an isolated dev rig (`ORCA_DEV_USER_DATA_PATH`, CDP, hidden window). Count discovery spans per `+` open over the same scenarios, and record menu-open-to-rows-settled time. Run under no load and under synthetic CPU load.
- Re-run the harness after the change. Raw output goes in `.context/perf/sta-13482/`.
