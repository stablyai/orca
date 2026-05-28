# Enable/Disable Agents Dashboard

## Problem

- GitHub issue #2907 asks for Settings -> Agents customization to enable/disable agents because users do not want every supported agent surfaced.
- `AgentsPane` lists every detected agent in the default picker and Installed section, with no per-agent visibility control ([src/renderer/src/components/settings/AgentsPane.tsx](../src/renderer/src/components/settings/AgentsPane.tsx:267), [src/renderer/src/components/settings/AgentsPane.tsx](../src/renderer/src/components/settings/AgentsPane.tsx:303), [src/renderer/src/components/settings/AgentsPane.tsx](../src/renderer/src/components/settings/AgentsPane.tsx:350)).
- Quick-launch and new-workspace surfaces use detected agents directly, so an installed but unwanted agent remains selectable ([src/renderer/src/components/tab-bar/QuickLaunchButton.tsx](../src/renderer/src/components/tab-bar/QuickLaunchButton.tsx:164), [src/renderer/src/components/NewWorkspaceComposerCard.tsx](../src/renderer/src/components/NewWorkspaceComposerCard.tsx:282)).
- Auto-pick uses catalog order over detected agents only, so a disabled-by-preference agent would still be launched by direct task/startup paths unless the preference is part of selection ([src/shared/tui-agent-selection.ts](../src/shared/tui-agent-selection.ts:37), [src/renderer/src/lib/launch-work-item-direct.ts](../src/renderer/src/lib/launch-work-item-direct.ts:254), [src/main/runtime/orca-runtime.ts](../src/main/runtime/orca-runtime.ts:6937)).
- Other launch helpers also hand-roll "default if detected, else first catalog match" logic and must not be missed (`GitHubItemDialog`, `PullRequestPage`, `SourceControl`, `ChecksPanel`, and `NewWorkspaceComposerModal`).
- Additional future-launch surfaces read `defaultTuiAgent` or `AGENT_CATALOG` directly and also need an explicit policy: automation creation, floating-terminal default-agent launch, and onboarding folder startup.

## Goal

Persist a user-controlled disabled agent list from Settings -> Agents, show an enable/disable control for every catalog agent, and treat disabled agents as unavailable for automatic defaults and visible launch choices while preserving command overrides and PATH detection.

## Non-goals

- Do not uninstall CLIs, mutate PATH, or change local/remote agent detection.
- Do not remove disabled agents from Settings -> Agents; users need a path to re-enable them.
- Do not block explicitly restored historical sessions that already reference an agent; this feature controls future picker/auto-pick availability.
- Do not add per-repo or per-SSH-host disabled state in this change.

## Design

1. Add `disabledTuiAgents: TuiAgent[]` to `GlobalSettings` with default `[]` in `getDefaultSettings`. Normalize persisted and settings-update values in `Store` load/update paths to a de-duplicated list of supported `TuiAgent` ids; readers should still defensively treat missing/invalid values as `[]` because old profiles and remote clients can omit the key.
2. Expose shared selection helpers from `src/shared/tui-agent-selection.ts`:
   - `normalizeDisabledTuiAgents(value): TuiAgent[]`;
   - `isTuiAgentEnabled(agent, disabled?)`;
   - `filterEnabledTuiAgents(agents, disabled?)`.
   Use `isTuiAgent` from `src/shared/tui-agent-config.ts` as the supported-agent source of truth; do not duplicate the union or renderer catalog in normalizers.
3. Extend `pickTuiAgent(preferred, detected, disabled?)` so disabled agents are excluded from both preferred-agent acceptance and catalog-order fallback. Keep `'blank'` returning `null`.
4. Add `disabledTuiAgents` to runtime client settings plumbing, not only desktop IPC:
   - include it in `orca-runtime.getClientSettings()` and `updateClientSettings()`; the service type currently omits `defaultTuiAgent` even though `client-ui` already accepts and forwards it, so fix that contract while adding `disabledTuiAgents`;
   - include it in `OrcaRuntime`'s `store.getSettings()` host type so runtime draft startup can read it without casts;
   - add it to `src/main/runtime/rpc/methods/client-ui.ts` `SettingsUpdate`, which is strict and will otherwise reject the key;
   - include it in web/mobile client settings types if they mirror the runtime settings response;
   - normalize it in web `mergeSettings()` too if paired web clients can persist host-independent settings locally.
5. Update every future-launch/default-selection path to pass `settings.disabledTuiAgents ?? []`:
   - new-workspace auto-selection in `useComposerState`;
   - quick-create preferred-agent selection in `NewWorkspaceComposerModal`;
   - direct task launch in `launch-work-item-direct`;
   - runtime/mobile draft startup in `orca-runtime`;
   - quick-launch menu ordering/filtering in `QuickLaunchButton`;
   - new-workspace `AgentCombobox` visible list in `NewWorkspaceComposerCard`;
   - one-click agent launch paths in `GitHubItemDialog`, `PullRequestPage`, `SourceControl`, and `ChecksPanel`;
   - new automation agent selection and any initial automation agent default derived from settings;
   - floating-terminal default-agent launch and onboarding folder startup, which launch from `defaultTuiAgent` without first checking detection.

   Preserve existing `'blank'` semantics per surface. Direct task startup and quick-create can represent no agent, so `'blank'` means no agent there. The full new-workspace composer currently stores a concrete `TuiAgent` and collapses `'blank'` to a required-agent fallback; do not claim it is a `pickTuiAgent`/blank-capable path unless the UI model is changed. Source-control/PR one-click helpers currently treat `'blank'` like auto-pick (`SourceControl.commit-drafts.test.ts` asserts this), so filter disabled agents there without blindly replacing those helpers with `pickTuiAgent` unless the product behavior is intentionally changed and tests are updated.
6. Update `AgentsPane` rows with a compact `SettingsSwitchRow`-style enabled control or equivalent shadcn switch using existing tokens. The control persists `disabledTuiAgents` by adding/removing the row's agent id. Disabled detected agents stay in Installed with a muted "Disabled" badge; disabled undetected agents stay in Available to install.
7. Default-agent reconciliation in `AgentsPane`: if the user disables the current default agent, persist one partial settings update containing both the new disabled list and `defaultTuiAgent: null`. A disabled default should make the Auto pill active and should not appear as a selectable default pill until re-enabled.
8. Treat settings writes as last-writer-wins. `updateSettings` accepts only partial objects, not functional updaters, so the toggle handler should read the latest store settings at click time and write only `disabledTuiAgents` plus the default reset when necessary. Normalization must happen in main/persistence too, because runtime clients can update settings without going through the renderer store slice.
9. Broadcast or otherwise synchronize `disabledTuiAgents`/`defaultTuiAgent` settings changes that originate outside the active renderer. Existing `settings:set` returns the full snapshot only to the caller, and `settings:changed` is currently used for the narrow View -> Appearance menu path; without a sync event, another window/client can keep showing stale agent choices until it refetches. A `settings:set`-only broadcast is insufficient because runtime `settings.update` calls `store.updateSettings()` directly; add a Store-level settings-change notification or an injected runtime callback so desktop IPC and runtime RPC share the same sync path. If using `settings:changed`, send the authoritative post-normalization values to every relevant webContents/runtime client, not only `mainWindow`, and do not add these keys to the telemetry `SETTINGS_CHANGED_WHITELIST` just to get synchronization.
10. Add search keywords for "enable", "disable", "hide", and "show" to the Agents pane search metadata.
11. Add focused tests:
   - shared `pickTuiAgent` ignores disabled preferred and fallback agents;
   - disabled-list normalization dedupes, drops unsupported ids, and runs on persisted load and `updateSettings`;
   - `AgentsPane` toggling disables/enables an agent and clears default when needed;
   - runtime `settings.update` accepts/persists disabled agents and `settings.get` returns them;
   - quick-launch/new-workspace, automation creation, floating-terminal launch, onboarding folder startup, and one-click launch filtering hides or skips disabled agents with the existing blank/default semantics preserved;
   - existing automation edit with a disabled selected agent displays and preserves that agent unless the user explicitly changes it;
   - settings-change broadcast updates a non-caller renderer/client store.

## Edge cases

- Disabled list contains an agent id no longer supported: readers ignore it, and the next write may drop it. This is acceptable because the feature only controls supported catalog agents.
- All detected agents disabled: auto-pick returns `null`; pickers show no enabled agents and keep existing "No agents detected" style copy adjusted to "No enabled agents" where appropriate.
- Default agent disabled in another window/client: every consumer must treat it as unavailable even if the stored `defaultTuiAgent` still names it.
- A detected-agent refresh must not clear or rewrite disabled preferences; PATH detection remains a raw capability snapshot, and filtering is a separate selection/presentation step.
- Remote SSH worktrees: remote detection still reports host-installed agents, but global disabled preferences filter those lists before display/auto-pick.
- Command overrides for disabled agents remain persisted so re-enabling restores the user's configured command.
- New automation forms should not offer disabled agents, but existing automations that already name a disabled agent are historical explicit configuration and should not be rewritten by this feature.
- When filtering `AgentCombobox` options, preserve any existing selected disabled value instead of letting the trigger fall back to "Blank Terminal". For edit forms such as automations, either include the selected disabled agent as an unavailable row or render the selected label separately; saving an unrelated edit must not silently rewrite the agent.
- Explicit agent launches from existing saved worktree metadata or already-open tabs are not rewritten; the feature controls future choices.
- If the selected agent becomes disabled while a composer or automation form is open, keep the form valid by moving to the next enabled detected/catalog agent or `null` before create; do not submit a disabled agent from stale local component state.
- Runtime create/draft paths should defensively apply disabled filtering to default/fallback selection and to caller-provided future-launch agent choices. Do not apply it to restore paths that are replaying already-persisted worktree/tab metadata.
- Direct edits to the persisted settings file are not live today. This feature should not promise external-file mutation support beyond the existing restart/refetch behavior.

## Rollout

1. Add the settings type/default, normalization, runtime client schema plumbing, and shared selection helpers/tests.
2. Wire disabled-agent filtering into auto-pick, visible launch surfaces, and one-click launch helpers.
3. Add the Settings -> Agents row toggle UI, default-clearing persistence behavior, and settings synchronization for non-caller clients.
4. Update settings search metadata and renderer tests.
5. Run targeted tests, then `pnpm typecheck` and `pnpm lint`.
