#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo 'Usage: install-ubuntu-apt-packages.sh <package>...' >&2
  exit 2
fi

bash "$(dirname "${BASH_SOURCE[0]}")/prepare-ubuntu-apt.sh"

# Eight minutes of command allowances leave room for tests within the job deadline.
if timeout 45 sudo apt-get update -o Acquire::Languages=none && timeout 120 sudo apt-get install -y "$@"; then
  exit 0
fi

echo 'Ubuntu package setup failed; trying the same packages through the MIT mirror.' >&2
for host in archive.ubuntu.com ports.ubuntu.com mirrors.mit.edu; do
  timeout 5 getent ahosts "$host" || true
done

bash "$(dirname "${BASH_SOURCE[0]}")/use-ubuntu-apt-mirror.sh"
bash "$(dirname "${BASH_SOURCE[0]}")/recover-ubuntu-dpkg.sh" || true
# Unrelated repositories may fail refresh; apt still verifies the requested packages.
if ! timeout 120 sudo apt-get update -o Acquire::Languages=none; then
  echo 'Index refresh incomplete; attempting the requested packages with available authenticated indexes.' >&2
fi
timeout 150 sudo apt-get install -y "$@"
