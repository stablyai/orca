# Worked example — Vercel Sandbox

Load this when writing the base-snapshot, auth, or `create` script for a snapshot-capable cloud
provider. It fills section 7's skeletons with a real surface, `vercel sandbox
create|exec|snapshot|remove`. Adapt the names and verify every flag against
`vercel sandbox --help` for the user's CLI version.

This is the Orca-server connection mode: the recipe emits a pairing URL. If the user chose SSH in
the interview, use `references/ssh-host.md` instead.

## Base snapshot

Provision, install tools and clone, build headless, then snapshot.

```bash
# provision a fresh build sandbox (retain a couple of snapshots); trap-remove on error
vercel sandbox create --name "$base" --runtime node24 --timeout 30m --vcpus 4 --publish-port "$port" \
  --snapshot-expiration 30d --keep-last-snapshots 2 "${vercel_args[@]}" >&2
# remote build (long timeout): install pkgs+gh+pnpm+agent CLI, clone with GIT_ASKPASS (the helper's
# \$1/\$GH_TOKEN escaping is load-bearing — see the guide's Credentials section — then
# `rm -f /tmp/askpass.sh`), write the headless main-only build config (drop the renderer), dev setup,
# build CLI + headless main, smoke-check
vercel sandbox exec "$base" "${vercel_args[@]}" --timeout 25m --env "GH_TOKEN=$gh_token" … -- bash -lc '…build…' >&2
# snapshot the STOPPED sandbox and parse the id from CLI output (fail if unparseable)
out="$(vercel sandbox snapshot "$base" --stop --expiration 30d "${vercel_args[@]}" 2>&1)"; printf '%s\n' "$out" >&2
snapshot_id="$(printf '%s\n' "$out" | sed -nE 's/.*(snap_[A-Za-z0-9]+).*/\1/p' | tail -1)"
# merge { baseName, snapshotId, scope, project, port, repoUrl, repoRef, projectRoot } into state; print state JSON
```

## Agent-auth snapshot

Boot the base, let the user log the agent in, verify, then re-snapshot. `codex` here is an example;
substitute the user's chosen agent's login and status verbs.

```bash
vercel sandbox create --name "$auth" --snapshot "$snapshot_id" --timeout 30m --publish-port "$port" "${vercel_args[@]}" >&2
# The USER runs this in their own terminal and completes the URL/code on the HOST.
vercel sandbox exec --interactive --tty "$auth" "${vercel_args[@]}" -- bash -lc 'codex login --device-auth'
```

Verify by exit code. The remote command prints a sentinel instead of relying on the exit code,
because a provider CLI may not propagate remote exit codes:

```bash
verdict="$(vercel sandbox exec "$auth" "${vercel_args[@]}" --timeout 30s \
  -- bash -lc 'if codex login status >/dev/null 2>&1; then echo ORCA_AGENT_LOGGED_IN; else echo ORCA_AGENT_LOGGED_OUT; fi')"
case "$verdict" in
  *ORCA_AGENT_LOGGED_IN*) ;;
  *) echo "agent not logged in; not snapshotting" >&2; exit 1 ;;
esac
```

Fallback for an agent whose `status` exit code says nothing about auth: capture the output with
stderr folded in and match the agent's exact success line. Match a variable, not a pipe, so the
provider process cannot take SIGPIPE:

```bash
status="$(vercel sandbox exec "$auth" "${vercel_args[@]}" --timeout 30s -- bash -lc 'codex login status 2>&1')"
grep -Eq 'Logged in using ChatGPT|Logged in via device' <<<"$status" \
  || { echo "agent not logged in; not snapshotting" >&2; exit 1; }
```

Then re-snapshot and record the new id:

```bash
out="$(vercel sandbox snapshot "$auth" --stop --expiration 30d "${vercel_args[@]}" 2>&1)"; printf '%s\n' "$out" >&2
new_id="$(printf '%s\n' "$out" | sed -nE 's/.*(snap_[A-Za-z0-9]+).*/\1/p' | tail -1)"
# overwrite state.snapshotId = new_id, record authSourceSnapshotId = snapshot_id; remove the auth sandbox
```

## Per-workspace `create`

```bash
#!/usr/bin/env bash
set -euo pipefail
# resolve from env→state→fallback: snapshot_id, scope, project, port, repo_url, repo_ref, project_root
vercel_args=(); [ -n "$scope" ] && vercel_args+=(--scope "$scope"); [ -n "$project" ] && vercel_args+=(--project "$project")
[ -n "$snapshot_id" ] || { echo "snapshotId missing — build the base and auth snapshots first" >&2; exit 1; }
gh_token="${GH_TOKEN:-${GITHUB_TOKEN:-$(command -v gh >/dev/null 2>&1 && gh auth token 2>/dev/null || true)}}"
recipe_id="${ORCA_RECIPE_ID:-vercel-sandbox}"
recipe_id="${recipe_id//./-}"  # Vercel names forbid dots.
instance_id="${ORCA_VM_INSTANCE_ID:-$(date +%s)}"
max_recipe_id_length=$((128 - ${#instance_id} - 6))  # Preserve the unique instance suffix.
[ "$max_recipe_id_length" -gt 0 ] || { echo "ORCA_VM_INSTANCE_ID is too long for a Vercel sandbox name" >&2; exit 1; }
name="orca-${recipe_id:0:max_recipe_id_length}-${instance_id}"

# Arm cleanup BEFORE create so a failing create can't leak a half-built paid sandbox.
cleanup_on_error() { [ "$?" -ne 0 ] && vercel sandbox remove "$name" "${vercel_args[@]}" >/dev/null 2>&1 || true; }
trap cleanup_on_error EXIT

# 1. boot from the authenticated snapshot, publish the serve port
create_output="$(vercel sandbox create --name "$name" --snapshot "$snapshot_id" \
  --timeout 30m --publish-port "$port" "${vercel_args[@]}" 2>&1)"; printf '%s\n' "$create_output" >&2
# Vercel prints the published https URL; derive the external wss:// pairing address from it
public_url="$(printf '%s\n' "$create_output" | sed -nE 's#.*(https://[^[:space:]]+\.vercel\.run).*#\1#p' | head -1)"
[ -n "$public_url" ] || { echo "no published URL in create output" >&2; exit 1; }
pairing_ws="${public_url/https:\/\//wss://}"

# 2. (remote) ensure the repo is at the right commit; rebuild only if the commit changed (cache marker)
vercel sandbox exec "$name" "${vercel_args[@]}" --timeout 20m \
  --env "GH_TOKEN=$gh_token" --env "ORCA_PROJECT_ROOT=$project_root" \
  --env "ORCA_REPO_URL=$repo_url" --env "ORCA_REPO_REF=$repo_ref" \
  -- bash -lc 'set -euo pipefail; cd "$ORCA_PROJECT_ROOT"; \
    # Escaping is load-bearing here: re-test the fetch after any edit to the nested quoting.
    if [ -n "${GH_TOKEN:-}" ]; then \
      printf "%s\n" "#!/usr/bin/env bash" "case \"\$1\" in *Username*) echo x-access-token;; *Password*) echo \"\$GH_TOKEN\";; esac" > /tmp/askpass.sh; \
      chmod 700 /tmp/askpass.sh; export GIT_ASKPASS=/tmp/askpass.sh GIT_TERMINAL_PROMPT=0; fi; \
    git fetch origin "$ORCA_REPO_REF"; \
    git checkout -B "$ORCA_REPO_REF" FETCH_HEAD; \
    rm -f /tmp/askpass.sh; \
    c="$(git rev-parse HEAD)"; [ -f .orca-built ] && [ "$(cat .orca-built)" = "$c" ] || { \
      pnpm install --prefer-offline && pnpm run build:cli && \
      node config/scripts/run-electron-vite-build.mjs --config config/electron-vite.vm-serve.config.ts && \
      printf "%s" "$c" > .orca-built; }' >&2

# 3. (remote) start orca serve in the background, writing recipe JSON to a file; poll until it parses
recipe_json="$(vercel sandbox exec "$name" "${vercel_args[@]}" --timeout 60s \
  --env "ORCA_PORT=$port" --env "ORCA_PROJECT_ROOT=$project_root" --env "ORCA_PAIRING_ADDRESS=$pairing_ws" \
  -- bash -lc 'set -euo pipefail; cd "$ORCA_PROJECT_ROOT"; rm -f /tmp/orca-recipe.json /tmp/orca-serve.log; \
    nohup pnpm exec orca-dev serve --port "$ORCA_PORT" --project-root "$ORCA_PROJECT_ROOT" \
      --pairing-address "$ORCA_PAIRING_ADDRESS" --recipe-json >/tmp/orca-recipe.json 2>/tmp/orca-serve.log </dev/null & \
    pid=$!; for _ in $(seq 1 80); do \
      node -e "JSON.parse(require(\"node:fs\").readFileSync(\"/tmp/orca-recipe.json\",\"utf8\"))" >/dev/null 2>&1 && { cat /tmp/orca-recipe.json; exit 0; }; \
      kill -0 "$pid" 2>/dev/null || { cat /tmp/orca-serve.log >&2; exit 1; }; sleep 0.25; \
    done; cat /tmp/orca-serve.log >&2; echo "serve recipe JSON timed out" >&2; exit 1')"

# 4. print serve's JSON enriched with userData (single object on stdout)
node -e 'const p=JSON.parse(process.argv[1]); console.log(JSON.stringify({...p, schemaVersion:1,
  userData:{...p.userData, provider:"vercel-sandbox", resourceId:process.argv[2], snapshotId:process.argv[3]}}))' \
  "$recipe_json" "$name" "$snapshot_id"
trap - EXIT
```

`suspend`, `resume`, and `destroy` run `vercel sandbox stop|...|remove "$resource_id"`, reading
`userData.resourceId` from the lifecycle payload on stdin.

The `128` in `max_recipe_id_length` is Vercel's sandbox name cap. Confirm it against
`vercel sandbox create --help` or Vercel's docs for the user's CLI version before relying on it; a
wrong cap silently truncates recipe ids in resource names.
