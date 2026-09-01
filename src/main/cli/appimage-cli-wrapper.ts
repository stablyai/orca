export function buildAppImageCliWrapper(appImagePath: string): string {
  // Why: AppRun may prepend Chromium-only flags, so enter Electron mode before
  // the main-process preflight redirects this explicit launch into Node mode.
  return `#!/usr/bin/env bash
set -euo pipefail
APPIMAGE=${quoteShell(appImagePath)}
if [ ! -f "$APPIMAGE" ]; then
  echo "Orca AppImage not found at $APPIMAGE" >&2
  echo "If you moved the AppImage, re-run CLI registration from Orca Settings." >&2
  exit 1
fi
export ORCA_NODE_OPTIONS="\${NODE_OPTIONS-}"
export ORCA_NODE_REPL_EXTERNAL_MODULE="\${NODE_REPL_EXTERNAL_MODULE-}"
unset NODE_OPTIONS
unset NODE_REPL_EXTERNAL_MODULE
export ORCA_APPIMAGE_CLI_LAUNCH=1
exec "$APPIMAGE" "$@"
`
}

export function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
