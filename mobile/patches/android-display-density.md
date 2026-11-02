# Android display density

Orca uses `plugins/android-window-density.js` from upstream main to keep React Native display metrics aligned with the Activity. This PR reuses that implementation; a second lifecycle plugin would duplicate its Kotlin overrides and fail prebuild.

## Navigation frames

The `react-native-screens` 4.24.0 patch converts frame width, height, and header height using the view resources' density, with global density as a fallback for nonpositive values. This keeps navigation frames aligned with their display on Samsung DeX. It backports the per-view conversion from [upstream PR #4160](https://github.com/software-mansion/react-native-screens/pull/4160).

The patch changes conversion when state updates run; it does not itself trigger updates when pixel bounds remain unchanged. Activity lifecycle and configuration handling belong to the existing window-density plugin.

## Maintenance and validation

After editing the patch, regenerate the pnpm lockfile, install with the frozen lockfile, and rebuild Android. Before removing the patch on an upgrade, check that the selected screens version includes per-view frame conversion.

Device validation is still required after integration with the upstream window-density plugin:

- Phone and DeX cold launches, and transitions in both directions.
- Window resize, split screen, density changes, and system font scaling.
- Fold8 folding and unfolding, including cover-screen use.
- Labels, navigation frames, dialogs, keyboard, terminal, and touch alignment.
- Local and SSH hosts, with both git worktrees and folder workspaces.
