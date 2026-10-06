#!/bin/zsh
set -eu
exec perl -MPOSIX=setsid -e 'setsid() or die "setsid: $!"; exec @ARGV' env -i \
  PATH="$PATH" \
  HOME=/Users/m4air/orca-qa/pr-25658/remote-released-parent/final-profile/home \
  ORCA_DEV_USER_DATA_PATH=/Users/m4air/orca-qa/pr-25658/remote-released-parent/final-profile/user-data \
  CODEX_HOME=/Users/m4air/orca-qa/pr-25658/remote-released-parent/final-profile/codex \
  CLAUDE_CONFIG_DIR=/Users/m4air/orca-qa/pr-25658/remote-released-parent/final-profile/claude \
  ORCA_BACKGROUND_LAUNCH=1 ORCA_STARTUP_DIAGNOSTICS=1 REMOTE_DEBUGGING_PORT=9441 \
  node /Users/m4air/orca/workspaces/orca/pr25658-review-qa-3/config/scripts/run-electron-vite-dev.mjs \
  -c /tmp/orca-pr25658-baseline-vite.mjs -- --password-store=basic --use-mock-keychain
