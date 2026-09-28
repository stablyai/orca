#!/bin/bash
# Launch Orca in dev mode with a visible window.
#
# Run this yourself from a terminal:
#   ./scripts/dev-local.sh
#
# It applies two local-machine workarounds:
#  1. Points the C++ compiler at the SDK's libc++ headers, because this machine's
#     Command Line Tools are missing /usr/include/c++/v1 (breaks node-pty build).
#     Permanent fix: `sudo rm -rf /Library/Developer/CommandLineTools && xcode-select --install`.
#  2. Adds a `pnpm` shim on PATH if pnpm isn't installed globally (falls back to corepack).
set -euo pipefail
cd "$(dirname "$0")/.."

SDK_CXX="/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/c++/v1"
if [ -d "$SDK_CXX" ] && [ ! -d "/Library/Developer/CommandLineTools/usr/include/c++/v1" ]; then
  export CXXFLAGS="${CXXFLAGS:-} -isystem $SDK_CXX"
  export CPLUS_INCLUDE_PATH="${CPLUS_INCLUDE_PATH:+$CPLUS_INCLUDE_PATH:}$SDK_CXX"
  echo "[dev-local] Applied SDK libc++ include workaround."
fi

if ! command -v pnpm >/dev/null 2>&1; then
  SHIM_DIR="$(mktemp -d)"
  cat > "$SHIM_DIR/pnpm" <<'SH'
#!/bin/bash
exec corepack pnpm "$@"
SH
  chmod +x "$SHIM_DIR/pnpm"
  export PATH="$SHIM_DIR:$PATH"
  echo "[dev-local] Using corepack pnpm shim."
fi

# Foreground launch: a normal, visible, focusable window. Do NOT set
# ORCA_BACKGROUND_LAUNCH here — that flag intentionally hides the window.
exec pnpm dev
