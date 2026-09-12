# Android display density

Orca synchronizes React Native's display metrics with the current Activity and converts navigation frame sizes using the view's density. This addresses text clipping and undersized content on external displays such as Samsung DeX.

## Activity metrics

`plugins/android-display-density.js` uses Expo's `withMainActivity` to initialize `DisplayMetricsHolder` before `super.onCreate(null)` and synchronize it again after creation, resume and configuration changes. The synchronization emits `didUpdateDimensions` and requests layout. The second initialization handles React Native overwriting the global metrics during root-view creation. System font scaling is preserved.

The plugin uses the existing public React Native API. It requires an Android native rebuild, but no additional React Native source patch, Android source-build setting or linker change. Existing iOS React Native patches and source-build configuration remain unchanged.

The approach overlaps with [Orca PR #16018](https://github.com/stablyai/orca/pull/16018) and the workaround in [React Native #57183](https://github.com/react/react-native/issues/57183). This plugin deliberately leaves Activity recreation and window/keyboard policy unchanged. The global holder is not a general solution for simultaneous surfaces on different displays.

## react-native-screens 4.24.0

`FabricEnabledViewGroup.updateState` divides frame width, height and header height by the view resources' density, falling back to global density if nonpositive. This backports [upstream PR #4160](https://github.com/software-mansion/react-native-screens/pull/4160). The fix ships in screens 4.26.0, which requires RN 0.84+, while Orca uses Expo 55 / RN 0.83.10.

The patch corrects conversion when state updates run; it does not add a state-update trigger for unchanged pixel bounds. Activity recreation is permitted during density transitions. Do not describe this as seamless DeX session preservation.

## Maintenance and validation

Update the pnpm patch hash after editing the screens patch, install with the frozen lockfile and regenerate Android with Expo prebuild. Plugin transform tests cover lifecycle ordering, template compatibility and repeat application; they do not replace native rendering tests.

Before removing the patch on a dependency upgrade, confirm the upstream frame conversion exists in the chosen release. Before extending the plugin, verify lifecycle ordering and any existing MainActivity overrides. It fails explicitly when another plugin already defines the same lifecycle methods.

Device checks:

- Phone and DeX cold launches; phone-to-DeX and reverse transitions.
- Window resize, density-only changes and system font scaling.
- Fold8 cover/unfolded screens and folding/unfolding.
- Labels, navigation frames, dialogs, keyboard, terminal and touch alignment.
- Local/SSH hosts and git/folder workspaces through display transitions.
