#!/usr/bin/env bash
set -euo pipefail
umask 077
mkdir -p /vercel/orca-control /vercel/orca-profile
exec 9>/vercel/orca-control/serve.lock
flock -n 9 || exit 0
boot_id="$(cat /proc/sys/kernel/random/boot_id)"
previous_boot="$(cat /vercel/orca-control/boot-id 2>/dev/null || true)"
# Restored Chromium and Orca's X99 display locks can name recycled PIDs in the new VM.
if [ -n "$previous_boot" ] && [ "$previous_boot" != "$boot_id" ]; then
  rm -f /vercel/orca-profile/SingletonLock /vercel/orca-profile/SingletonSocket /vercel/orca-profile/SingletonCookie
  rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
fi
printf '%s' "$boot_id" >/vercel/orca-control/boot-id
printf '%s' "$ORCA_VERCEL_SESSION" >/vercel/orca-control/session-id
rm -f /vercel/orca-control/ready.json
export ORCA_BACKGROUND_LAUNCH=1 LIBGL_ALWAYS_SOFTWARE=1
export ORCA_DEV_USER_DATA_PATH=/vercel/orca-profile
agent_home="$HOME/.codex"
mkdir -p "$agent_home"
if [ -n "${AI_GATEWAY_API_KEY:-}" ] && [ ! -e "$agent_home/config.toml" ]; then
  cat >"$agent_home/config.toml" <<'TOML'
model_provider = "vercel"
model = "openai/gpt-5.6-terra"
[model_providers.vercel]
name = "Vercel AI Gateway"
base_url = "https://ai-gateway.vercel.sh/codex/v1"
env_key = "AI_GATEWAY_API_KEY"
wire_api = "responses"
TOML
fi
cd /vercel/orca-runtime
exec node config/scripts/orca-dev.mjs serve --port 6768 \
  --project-root /vercel/project --pairing-address "$ORCA_PUBLIC_WSS" --recipe-json \
  >/vercel/orca-control/ready.json 2>/vercel/orca-control/server.log
