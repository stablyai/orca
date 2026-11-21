# Mobile file-upload simulator E2E

Maestro flow for the terminal attach menu (Select from Gallery, Files).

## Setup

- A real desktop to pair with, isolated from your own Orca: `ORCA_BACKGROUND_LAUNCH=1 pnpm dev:fresh` (temporary profile, hidden window). Take its profile path from the `ORCA_DEV_INSTANCE` line, then `export ORCA_USER_DATA_PATH=<that path>`, add a throwaway repo with `orca repo add --path <dir>`, open a shell with `orca terminal create --worktree path:<dir> --title e2e`, and print a link with `orca pair --mobile --address 127.0.0.1`. Open that link in the simulator (`xcrun simctl openurl <udid> '<link>'`) and confirm.
- The app: `pnpm native ensure ios`, then `pnpm start --dev-client`.
- Booted iPhone simulator running the Orca dev client, paired to a desktop and sitting on a live shell terminal tab with an empty prompt.
- Photos library holds a video as the first tile and a photo as the second (add with `xcrun simctl addmedia <udid> photo.png clip.mp4`).
- `notes.json` and `readme.txt` copied into the simulator's `File Provider Storage` (under `Containers/Shared/AppGroup/*/`) so they appear in Files > Browse > On My iPhone.
- `maestro` plus Java 21: `export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home; export PATH=$JAVA_HOME/bin:$PATH`.

## Run

    maestro --device <udid> test --test-output-dir=./out mobile/e2e/simulator/file-upload.yaml

## Verify on the host

Streamed uploads land in `<userData>/agent-session-attachments/<uuid>/<name>` and the paths are typed into the terminal; compare `shasum -a 256` with the sources. Gallery photos go through the image-paste path (`orca-paste-*.png` in the OS temp dir), videos and files stream to the attachments store.

## Notes

- Coordinates (attach button 81%,92%; gallery tiles; confirm 90%,16%) assume iPhone 17 Pro.
- `takeScreenshot` names are relative; frames may lag the UI slightly, so each is preceded by a wait.
