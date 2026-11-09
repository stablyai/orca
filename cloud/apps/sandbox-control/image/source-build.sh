#!/usr/bin/env bash
# Golden build from source, run by the Worker inside the build sandbox: orcad + the orca CLI from one
# commit of the Orca repo (cloud/integration carries host RPCs no upstream release has), then the same
# provision-golden.sh every image uses. Inputs (env):
#   ORCA_SRC_SHA (40-hex) and either ORCA_SRC_DIR (source already uploaded) or ORCA_SRC_REPO
#   (https://github.com/<owner>/<repo>) + ORCA_SRC_AUTH (an
#   `Authorization: Basic …` header value for a 1 h read-only installation token; never printed),
#   ORCA_PROVISION_SCRIPT (base64 of provision-golden.sh) + everything provision-golden.sh reads.
set -euo pipefail
log() { printf '[source-build] %s\n' "$*" >&2; }
start=$(date +%s)
[[ "$ORCA_SRC_SHA" =~ ^[0-9a-f]{40}$ ]] || { log 'ORCA_SRC_SHA must be a full commit sha'; exit 2; }

log 'build tools'
if command -v apt-get >/dev/null; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends build-essential python3 git ca-certificates >/dev/null
else
  sudo dnf install -y -q gcc gcc-c++ make tar gzip python3 git >/dev/null
fi
sudo corepack enable >/dev/null 2>&1 || true

src="$HOME/orca-src"
if [ -n "${ORCA_SRC_DIR:-}" ]; then
  # Operator rotation (image/rotate-golden-from-source.ts) uploaded `git archive <sha>` here already.
  log "uploaded source for $ORCA_SRC_SHA"
  src="$ORCA_SRC_DIR"
  cd "$src" && test -f package.json
  git init -q && git add -A && git -c user.email=build@orca -c user.name=build commit -qm "$ORCA_SRC_SHA"
else
  log "fetch $ORCA_SRC_SHA"
  rm -rf "$src" && mkdir -p "$src" && cd "$src"
  git init -q
  # The header lives only in this one command's config, not in .git/config.
  git -c "http.https://github.com/.extraheader=$ORCA_SRC_AUTH" fetch -q --depth 1 "$ORCA_SRC_REPO" "$ORCA_SRC_SHA"
  unset ORCA_SRC_AUTH
  git -c advice.detachedHead=false checkout -q FETCH_HEAD
  test "$(git rev-parse HEAD)" = "$ORCA_SRC_SHA"
fi

log 'build orcad + CLI'
export CI=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
corepack pnpm install --frozen-lockfile >/tmp/src-install.log 2>&1 || { tail -40 /tmp/src-install.log >&2; exit 1; }
corepack pnpm -C mobile install --frozen-lockfile >/tmp/src-mobile.log 2>&1 || { tail -40 /tmp/src-mobile.log >&2; exit 1; }
corepack pnpm build:mobile-web >/tmp/src-mobile-web.log 2>&1 || { tail -40 /tmp/src-mobile-web.log >&2; exit 1; }
corepack pnpm build:orcad >/tmp/src-orcad.log 2>&1 || { tail -60 /tmp/src-orcad.log >&2; exit 1; }
corepack pnpm build:cli >/tmp/src-cli.log 2>&1 || { tail -40 /tmp/src-cli.log >&2; exit 1; }
mkdir -p out/orca-cli
node_modules/.bin/esbuild out/cli/index.js --bundle --platform=node --target=node22 --format=cjs \
  --outfile=out/orca-cli/orca-cli.cjs --log-level=error
printf '%s\n' "$ORCA_SRC_SHA" >out/orcad/SOURCE_COMMIT
tar czf /tmp/orcad.tgz -C out orcad runtimes orca-cli
log "built in $(( $(date +%s) - start ))s"

export ORCAD_BUNDLE_URL=file:///tmp/orcad.tgz
ORCAD_BUNDLE_SHA256="$(sha256sum /tmp/orcad.tgz | cut -d' ' -f1)"
export ORCAD_BUNDLE_SHA256
cd "$HOME"
printf '%s' "$ORCA_PROVISION_SCRIPT" | base64 -d >/tmp/provision-golden.sh
unset ORCA_PROVISION_SCRIPT
bash /tmp/provision-golden.sh
# Build leftovers stay out of the image.
rm -rf "$src" "$HOME/.local/share/pnpm" "$HOME/.cache/pnpm" /tmp/orcad.tgz /tmp/provision-golden.sh /tmp/src-*.log
log "done in $(( $(date +%s) - start ))s"
