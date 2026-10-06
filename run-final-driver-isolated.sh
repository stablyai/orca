#!/bin/zsh
set -eu
exec env -i \
  PATH="$PATH" \
  HOME=/Users/m4air/orca-qa/pr-25658/remote-released-parent/final-profile/home \
  ORCA_DEV_USER_DATA_PATH=/Users/m4air/orca-qa/pr-25658/remote-released-parent/final-profile/user-data \
  CODEX_HOME=/Users/m4air/orca-qa/pr-25658/remote-released-parent/final-profile/codex \
  CLAUDE_CONFIG_DIR=/Users/m4air/orca-qa/pr-25658/remote-released-parent/final-profile/claude \
  ORCA_BACKGROUND_LAUNCH=1 \
  node /Users/m4air/orca-qa/pr-25658/remote-released-parent/final-driver.mjs
