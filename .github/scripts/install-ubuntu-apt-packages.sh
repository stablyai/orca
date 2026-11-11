#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo 'Usage: install-ubuntu-apt-packages.sh <package>...' >&2
  exit 2
fi

bash "$(dirname "${BASH_SOURCE[0]}")/prepare-ubuntu-apt.sh"

# Both routes and diagnostics fit the previous seven-minute package setup budget.
if timeout 45 sudo apt-get update && timeout 120 sudo apt-get install -y "$@"; then
  exit 0
fi

echo 'Ubuntu package setup failed; trying the same packages through the MIT mirror.' >&2
for host in archive.ubuntu.com ports.ubuntu.com mirrors.mit.edu; do
  timeout 5 getent ahosts "$host" || true
done

# Change repository locations while retaining suites, architectures and signing keys.
for source in /etc/apt/apt-mirrors.txt /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
  if [ -f "$source" ]; then
    sudo sed -i -E \
      -e 's#https?://(azure\.archive|archive|security)\.ubuntu\.com/ubuntu#https://mirrors.mit.edu/ubuntu#g' \
      -e 's#https?://ports\.ubuntu\.com/ubuntu-ports#https://mirrors.mit.edu/ubuntu-ports#g' \
      "$source"
  fi
done

timeout 60 sudo apt-get update
timeout 180 sudo apt-get install -y "$@"
