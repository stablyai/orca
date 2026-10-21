#!/usr/bin/env bash
# Loads a restored fixture image; only the default-branch warmer builds and exports a missing one.
set -euo pipefail
case "$FIXTURE" in
  headless-serve-shutdown|cli-launch-contract|daemon-shutdown-descendants) ;;
  *) echo "Unsupported package fixture: $FIXTURE" >&2; exit 1 ;;
esac
archive="$RUNNER_TEMP/orca-package-fixtures/$FIXTURE.tar"
image="orca-package-fixture-$FIXTURE:cache"
if [[ "${CACHE_HIT:-}" == true ]] && docker load --input "$archive"; then
  if docker image inspect "$image" > /dev/null; then
    echo "image=$image" >> "$GITHUB_OUTPUT"
    exit 0
  fi
fi
if [[ "${SAVE_CACHE:-}" != true ]]; then
  echo 'No usable fixture cache; the package runner will build normally.'
  exit 0
fi
docker build --platform linux/amd64 --build-arg BUILDKIT_INLINE_CACHE=1 \
  --tag "$image" --file "config/docker/$FIXTURE/Dockerfile" "config/docker/$FIXTURE"
mkdir -p "$(dirname "$archive")"
docker save --output "$archive" "$image"
echo "image=$image" >> "$GITHUB_OUTPUT"
echo 'built=true' >> "$GITHUB_OUTPUT"
