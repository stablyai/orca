## 1. Core Logic

- [x] 1.1 In `src/main/git/runner.ts`, declare a local module-level variable `defaultWslDistroOverride` and export the setter function `setDefaultWslDistroOverride`.
- [x] 1.2 In `src/main/git/runner.ts`, update `resolveDefaultWslCli` to prioritize `defaultWslDistroOverride` if it is not null.

## 2. Integration and Settings Synchronization

- [x] 2.1 In `src/main/index.ts`, query the initial store settings and call `setDefaultWslDistroOverride` at startup.
- [x] 2.2 In `src/main/index.ts`, update `setDefaultWslDistroOverride` inside `store.onSettingsChanged` when `terminalWindowsWslDistro` changes.

## 3. Testing and Verification

- [x] 3.1 Write a new unit/integration test in `src/main/git/runner-wsl-gh-fallback.test.ts` to assert that fallback resolves to the overridden distro if configured, and falls back to default WSL distro otherwise.
- [x] 3.2 Verify that all tests pass by running `pnpm test`.
