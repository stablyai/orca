# Orca Wake Dev functional test

`Orca Wake Dev` is an explicit local/test-only macOS flavor. It installs beside official Orca and cannot update or replace it.

## Fixed identities

| Surface                      | Orca Wake Dev                                 | Official Orca                        |
| ---------------------------- | --------------------------------------------- | ------------------------------------ |
| App and executable           | `Orca Wake Dev.app` / `Orca Wake Dev`         | `Orca.app` / `Orca`                  |
| Bundle ID                    | `com.ram4dev.orca-wake-dev`                   | `com.stablyai.orca`                  |
| CLI                          | `orca-wake`                                   | `orca`                               |
| Profile root                 | `~/Library/Application Support/orca-wake-dev` | `~/Library/Application Support/orca` |
| Controlled Codex socket root | `/tmp/ocw-wake-$UID`                          | `/tmp/ocw-$UID`                      |
| Updates                      | Disabled                                      | Unchanged                            |

The flavor reuses the repository's canonical Orca icon; its product and display name provide the deliberate branding distinction without another icon source to maintain.

## Build and install beside official Orca

Start from a clean-enough worktree whose user changes are understood. The command sets the flavor profile for every build stage; do not invoke `electron-builder` directly.

```bash
pnpm run build:mac:wake-dev
```

Expected artifacts are under `dist/wake-dev/`, including `orca-wake-dev-macos-arm64.dmg` and `orca-wake-dev-macos-x64.dmg`. Install the matching DMG as `/Applications/Orca Wake Dev.app`. Do not replace, rename, or modify `/Applications/Orca.app`.

Record identity evidence before launch:

```bash
defaults read "/Applications/Orca Wake Dev.app/Contents/Info" CFBundleIdentifier
defaults read "/Applications/Orca Wake Dev.app/Contents/Info" CFBundleDisplayName
ls -ld "/Applications/Orca.app" "/Applications/Orca Wake Dev.app"
```

The local flavor is intentionally unsigned/ad-hoc and not notarized. macOS may require an explicit local approval to open it. Never supply or copy Developer ID, notarization, provider, or production deployment credentials into this build.

## Launch, login, and state isolation

1. Launch official Orca and note its open workspace and Settings state.
2. Launch `/Applications/Orca Wake Dev.app` while official Orca remains open. Both apps must remain running and show distinct names in the Dock and Activity Monitor.
3. Complete provider login separately in Orca Wake Dev. Do not copy `orca-data.json`, managed provider homes, Keychain entries, tokens, cookies, or credential files from official Orca. A login prompt is expected because the app name and user-data root are separate.
4. In Wake Dev, add a disposable repository or folder workspace and change one harmless setting. Confirm neither appears in official Orca after refocusing or restarting it.
5. Confirm isolated paths and runtime discovery:

```bash
test -f "$HOME/Library/Application Support/orca-wake-dev/orca-runtime.json"
test -d "$HOME/Library/Application Support/orca-wake-dev/logs"
test -d "$HOME/Library/Application Support/orca-wake-dev/cache"
```

Do not print runtime metadata, auth tokens, provider files, or Keychain values as evidence.

## CLI and updater isolation

Use the in-app CLI installation action, then verify it claims only `orca-wake`:

```bash
command -v orca-wake
readlink "$(command -v orca-wake)"
orca-wake status
command -v orca
```

The `orca-wake` launcher must target `Orca Wake Dev.app/Contents/Resources/bin/orca-wake` and must read the wake-dev profile. The existing `orca` command and target must remain unchanged.

Open the update UI and use any visible update action. Wake Dev must neither load `electron-updater`, fetch release lists, download an update, nor offer install/restart-for-update. Official Orca's update behavior remains unchanged.

## Controlled wake feature flags

Quit any running Wake Dev process before the exercise; `open -a` would only reactivate it with
its original environment. Launch the executable directly with all three opt-in flags on the same
command and a disposable provider conversation:

```bash
osascript -e 'quit app "Orca Wake Dev"'
while pgrep -x "Orca Wake Dev" >/dev/null; do sleep 1; done
ORCA_FEATURE_CODEX_CONTROLLED_LAUNCH=1 \
ORCA_FEATURE_CODEX_CONTROLLED_PROVIDER=1 \
ORCA_FEATURE_ORCHESTRATION_CONVERSATION_WAKE=1 \
  "/Applications/Orca Wake Dev.app/Contents/MacOS/Orca Wake Dev" &
WAKE_DEV_PID=$!
```

Before dispatching the worker, verify only the three expected values without printing the rest of
the process environment:

```bash
for flag in \
  ORCA_FEATURE_CODEX_CONTROLLED_LAUNCH \
  ORCA_FEATURE_CODEX_CONTROLLED_PROVIDER \
  ORCA_FEATURE_ORCHESTRATION_CONVERSATION_WAKE; do
  if ps eww -p "$WAKE_DEV_PID" | tr ' ' '\n' | grep -qx "${flag}=1"; then
    printf '%s=1 verified\n' "$flag"
  else
    printf '%s=1 missing\n' "$flag" >&2
    exit 1
  fi
done
```

To activate both kill switches, quit and relaunch Wake Dev directly:

```bash
osascript -e 'quit app "Orca Wake Dev"'
while pgrep -x "Orca Wake Dev" >/dev/null; do sleep 1; done
ORCA_DISABLE_CODEX_CONTROLLED_SESSION=1 \
ORCA_DISABLE_ORCHESTRATION_CONVERSATION_WAKE=1 \
  "/Applications/Orca Wake Dev.app/Contents/MacOS/Orca Wake Dev" &
WAKE_DEV_PID=$!
```

Quit and relaunch without the kill switches only for the planned test. Unsupported SSH, WSL, relay, folder-workspace, account-drift, and protocol cases must still fail closed.

## End-to-end `worker_done` wake

1. In Wake Dev, create or select a disposable git worktree and start one controlled Codex conversation.
2. From that visible controlled pane, create or select the Run with `orca-wake orchestration run-create --objective "Wake Dev functional test"` or `orca-wake orchestration run-use --id <run_id>`.
3. Dispatch one disposable worker task through the established test workflow. Preserve the real `taskId`, `dispatchId`, coordinator, and worker handle; never synthesize lifecycle provenance.
4. From the dispatched worker terminal, send exactly one approved `worker_done` carrying those exact identifiers.
5. Verify the coordinator conversation receives one wake turn without PTY text injection or an extra Enter. Confirm duplicate reconciliation does not create a second turn and that the visible TUI remains attached to the same controlled app-server.
6. Capture only non-secret evidence: app bundle ID/name, Wake Dev PID, redacted Run/task/dispatch IDs, one committed lifecycle message ID, one resulting coordinator turn ID, socket root prefix, and terminal status. Do not capture transcript bodies, auth material, socket tokens, or credential files.

## Rollback and official-app proof

Before rollback, quit Wake Dev and remove its installed CLI from the in-app CLI action. Confirm `orca-wake` no longer resolves. Then move `/Applications/Orca Wake Dev.app` to Trash. Keep the profile for diagnosis, or move only this exact directory to a recoverable rollback location after reviewing the target:

```bash
test "$HOME/Library/Application Support/orca-wake-dev" != "$HOME/Library/Application Support/orca"
mv "$HOME/Library/Application Support/orca-wake-dev" "$HOME/.Trash/orca-wake-dev-rollback"
```

Finally relaunch official Orca and verify its prior workspace, settings, login, CLI target, updater behavior, and `/tmp/ocw-$UID` socket namespace are intact. Do not delete or migrate anything under the official profile, app bundle, CLI path, or Keychain entries.
