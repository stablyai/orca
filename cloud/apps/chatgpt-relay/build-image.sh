#!/usr/bin/env bash
# Builds the relay image with Cloud Build (context: cloud/apps) and prints its digest-pinned name for
# `terraform apply -var image=...` in cloud/infra/chatgpt-relay.
# Usage: build-image.sh <project> [region]
set -euo pipefail
project="${1:?project}"
region="${2:-us-central1}"
apps="$(cd "$(dirname "$0")/.." && pwd)"
repo="$region-docker.pkg.dev/$project/orca-chatgpt-relay/relay"
tag="$(git -C "$apps" rev-parse --short=12 HEAD)"
gcloud builds submit "$apps" --project "$project" --region "$region" --quiet \
  --config /dev/stdin <<YAML >&2
steps:
  - name: gcr.io/cloud-builders/docker
    args: [build, -f, chatgpt-relay/Dockerfile, -t, "$repo:$tag", .]
images: ["$repo:$tag"]
YAML
digest="$(gcloud artifacts docker images describe "$repo:$tag" --project "$project" --format='value(image_summary.digest)')"
echo "$repo@$digest"
