#!/usr/bin/env bash
set -euo pipefail

# GitHub's mirror+file sources resolve through apt-mirrors.txt, not just sources.list.
for source in /etc/apt/apt-mirrors.txt /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
  if [ -f "$source" ]; then
    sudo sed -i 's|https*://azure\.archive\.ubuntu\.com/ubuntu|https://archive.ubuntu.com/ubuntu|g' "$source"
  fi
done
sudo tee /etc/apt/apt.conf.d/99-orca-ci >/dev/null <<'APTCONF'
Acquire::http::Timeout "15";
Acquire::https::Timeout "15";
Acquire::Retries "1";
APTCONF
