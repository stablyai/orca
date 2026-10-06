#!/usr/bin/env bash
# Links Orca's Omarchy template into the user's Omarchy themed-template dir so
# `omarchy theme set` renders ~/.local/state/omarchy/current/theme/orca.json.
# Idempotent: re-running replaces the link in place.

set -euo pipefail

source_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/orca.json.tpl"
target_dir="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/themed"
target_path="$target_dir/orca.json.tpl"

[[ -f $source_path ]] || { echo "Missing $source_path" >&2; exit 1; }

mkdir -p "$target_dir"
ln -sfn "$source_path" "$target_path"
echo "Linked $target_path -> $source_path"

# Render once now so Orca can offer the option without waiting for the next theme switch.
if command -v omarchy-theme-refresh >/dev/null 2>&1; then
  omarchy-theme-refresh >/dev/null && echo "Re-rendered the current Omarchy theme."
else
  echo "Run 'omarchy theme set <name>' to render orca.json."
fi
