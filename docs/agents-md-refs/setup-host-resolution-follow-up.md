# Setup host resolution follow-up

This independent main-based work preserves the initial workspace-owner discovery fix. Do not land the frozen onboarding delta or this branch yet.

## Onboarding branch integration

Replace `use-onboarding-skill-runtime.ts`'s preference/local-catalog routing with the existing workspace launch context. Integrate setup routing on the onboarding branch using `resolveAgentLaunchRoute`; do not add an unused setup routing hook here. Pass host capabilities and registered-agent statuses for the actual owner, including client capabilities for paired hosts. Read registered agents and catalog loading/failure through one coherent snapshot owned by the catalog module, including its runtime-ID resolution. Do not substitute a local owner for a remote project because Chat UI is enabled.

Keep `useActiveProjectSkillRuntime` as the workspace install/discovery authority. Use its discovery runtime and target for every setup status hook and its bundled target for planning and installation. A null discovery runtime waits for unresolved ownership; an unsupported discovery runtime settles without scanning and displays unavailable. WSL retains its terminal command path and distro; direct SSH without a serving Orca server remains unsupported for bundled installation and discovery. A managed serving server plans its own disk. Folder workspaces use their resolved owner just like git worktrees.

A global setup surface is not automatically local floating Chat. Only an explicitly floating launch context uses local execution (`workspaceKind: 'floating'`); obtain that from the actual launch target. Web/mobile's local API means its serving host, not the device displaying the page. Use the same host capabilities, client capability negotiation, and terminal fallback as regular launches on all platforms.

When routing is integrated, render its discriminated status directly, without synchronized booleans or additional routing effects:

- `no-agent`: show “Choose an agent” and the existing agent-selection/settings control. Blank intentionally launches no agent; null/undefined must not invent a provider. Reselecting a supported agent restores readiness.
- `pending`: show checking. The existing host/catalog owner loads capabilities and inventory; do not claim absent/installed while unestablished.
- `failed`: show the persistent catalog error and a “Retry” button calling `retryCatalog`. The same mounted surface transitions through pending to ready on success, without a settings toggle or host switch.
- `unsupported`: show that the selected provider has no supported skill placement and offer agent selection.
- `ready`: retain the returned launch route and skill source owner. Terminal fallback keeps terminal provider roots. Chat source owners may differ from the selected agent (OpenClaude uses Claude).

The frozen delta's `target.agent` protocol is not on main. Integrate provider-specific install and discovery together on the source branch. Negotiate server support before forwarding provider-specific requests to paired servers: older servers need compatible behavior or a visible update-required action, never a local fallback. Use the same provider semantics for discovery and installation.

Discovery now keys mounted state and pending/cache sharing by pairing revision and verified runtime ID. Equivalent workspace resolution may remain stable across replacement without preserving retired host results. Existing eviction still prevents retired reads from repopulating the cache.

Add source-branch UI/integration coverage for the controls above, paired provider negotiation, explicit floating scope, WSL/SSH, and web/mobile. Rendered Orca validation requires the electron skill and hidden/background CDP.

## Separate installer lifecycle follow-up (P2)

Switching away and back, or remounting a setup component, must not admit duplicate installation for the same target. Own exclusion in the installer lifecycle outside React component state, keyed by actual host incarnation and provider/operation. Keep it until the underlying job settles, with cross-surface progress/rejoin behavior and finally cleanup. Component keys, disabled booleans, and remount guards cannot establish that exclusion. Cover leave/re-enter and parallel surfaces with deferred installation completions in a separate worktree.
