---
name: orca-per-workspace-env
description: >-
  Set up, review, debug, or validate Orca per-workspace environment recipes —
  on-demand, disposable runtimes (cloud sandboxes, VMs, or local) created fresh
  for each workspace. Covers first-time setup (provider prerequisites, the
  reusable base snapshot, the coding-agent auth snapshot, credentials, and
  state), not just the per-workspace lifecycle scripts. Use to stand up
  per-workspace environments, fix a `vmRecipes` entry in `orca.yaml`, scaffold
  provider lifecycle scripts, or resolve an `orca vm recipe doctor` failure.
---

# Per-Workspace Environments

Help a user stand up and maintain a repo-owned per-workspace environment recipe end to end. Each
workspace gets its own on-demand, disposable runtime (a cloud sandbox, a VM, or a local one),
created fresh and torn down after.

Orca is a **thin wrapper**: you guide, detect, and scaffold; you never own the user's cloud account,
billing, images, or credentials.

- **You DO:** sequence the setup, detect what's detectable (provider CLI present/logged-in? recipe
  present? `doctor` passing?), scaffold provider-templated scripts the user fills in, drive the slow
  snapshot/auth phases with the user, and always show the next action.
- **You DO NOT:** create accounts, choose plans/regions, invent org/project/scope ids, store or print
  secrets, or run anything that spends money without an explicit user OK.

First-time setup has **four phases before the per-workspace recipe runs** — easy to miss, so walk
them in order:

1. **Prerequisites** — cloud account, provider CLI, scope/project, plan limits, git token (§2).
2. **Base snapshot** — reusable image: tools + repo + headless build, snapshotted once (§3).
3. **Agent-auth snapshot** — boot the base, run interactive device-auth, re-snapshot (§4).
4. **State** — thread snapshot id / scope / project / port between phases via a state file (§6).

Then the **per-workspace contract** (create/suspend/resume/destroy) runs fast (§8).

---

## 1. Setup workflow

Drive these with the user. **[CHECKPOINT]** steps need explicit confirmation — they spend money, take
a long time, or need the user at the keyboard. Never create an Orca workspace or commit unless asked.

1. **Inspect the repo** for an existing `vmRecipes` entry, `scripts/orca-vm/`, a state file, or setup
   notes. If a working recipe exists, jump to Doctor (§9) instead of rebuilding.
2. **Pick the provider** if the repo doesn't make it obvious (Vercel Sandbox, Fly, Modal, raw VM…) and
   which coding-agent CLI runs in the VM (`codex`, `claude`…).
3. **Check prerequisites (§2)** — detect provider CLI + auth; ask for scope/project, plan limits, and
   the git token source. Don't guess.
4. **Scaffold scripts + state file** from §7, filling in the provider's commands. Make them executable.
5. **[CHECKPOINT] Build the base snapshot (§3)** — paid, slow.
6. **[CHECKPOINT] Authenticate the agent (§4)** — interactive; the user follows a URL/code.
7. **Wire the recipe** so `orca.yaml` points create/suspend/resume/destroy at the scripts (§8).
8. **Dry-run doctor** — `orca vm recipe doctor <recipe-id> --repo-path <repo> --json` (free, static; §9).
   Fix every failure before going live.
9. **[CHECKPOINT] Live self-test** — get the user's OK once, then run
   `orca vm recipe doctor <recipe-id> --provision --json` as a loop: it runs create → validates →
   destroys, and on failure returns a full transcript. Read it, fix the scripts, and re-run yourself until
   it passes (§9). Spends cloud money; the one approval covers the loop.
10. **[CHECKPOINT] Optional workspace test** — only if asked: create a workspace via the picker, then
    verify sleep/wake/delete.

---

## 2. Phase 1 — Prerequisites

The user's responsibility; verify what's verifiable, ask for the rest, invent nothing. State which
items you verified vs. which the user asserted.

- **Cloud account + plan** that allows sandboxes/VMs. Ask.
- **Provider CLI installed + authenticated** — detect (`command -v <cli>`), check auth (e.g.
  `vercel whoami`). If missing, point at the provider's docs; don't log them in.
- **Scope / project / region** the sandboxes live under. Ask; flows into every script via state.
- **Plan / timeout / RAM caps.** Record them — e.g. Vercel Hobby caps sandbox timeout at **45m**,
  which limits both the base build and per-workspace runtime (see §10).
- **Git token for private repos** (`GH_TOKEN`/`GITHUB_TOKEN`, or the provider's git auth; can fall back
  to `gh auth token`). See §5.
- **Coding-agent CLI choice** (`codex`, `claude`…) and that the user has an account — it gets
  authenticated into the VM in Phase 3.

---

## 3. Phase 2 — Base snapshot (the reusable image)

Build **once**, snapshot, and every workspace boots from it in seconds instead of rebuilding.
Provisioning + building takes a while (often ~20–30 min), so it runs behind a checkpoint. The script
shape is §7a; key points:

- Build the **headless Electron main only** (not the renderer) so it fits in plan RAM.
- Use the VM image's package manager (`apt`/`dnf`/`apk`, per the base distro — not the provider brand).
- Clone with the git token via `GIT_ASKPASS` (§5).
- **Trap errors and remove the half-built sandbox** so a crash doesn't leave a paid resource running.
- Snapshot the stopped sandbox, parse the snapshot id, and write it + scope/project/port/repo to state.

---

## 4. Phase 3 — Agent-auth snapshot (interactive)

The base snapshot has the agent CLI installed but **not logged in**, and per-workspace VMs are
ephemeral — so authenticate once and bake it into a second snapshot layer. Script shape is §7b:

1. Boot a sandbox from the base `snapshotId` (from state).
2. Run the agent's device/OAuth login **interactively** (`--interactive --tty`); the user completes the
   URL/code in their browser.
3. Verify login; **refuse to snapshot an unauthenticated VM.**
4. Re-snapshot, parse the new id, and overwrite `snapshotId` in state to the authenticated image
   (recording `authSourceSnapshotId`). Remove the auth sandbox.

If the agent's credentials are short-lived, warn that the snapshot may need periodic re-auth (§10).

---

## 5. Credentials

- **Never** commit secrets or put them in `userData`, recipe JSON, comments, docs, or the state file.
- **Git token:** read from env (`GH_TOKEN`/`GITHUB_TOKEN`), falling back to `gh auth token`. Pass to the
  VM only via the provider's ephemeral `--env`. Inside the VM, use a `GIT_ASKPASS` helper with
  `x-access-token` (not the token in the clone URL) and `GIT_TERMINAL_PROMPT=0` so a missing token fails
  fast instead of hanging.
- **Provider auth:** rely on the provider CLI's logged-in session, not checked-in keys.
- **Agent auth:** lives in the authenticated snapshot (Phase 3) — never a file you write or commit.
- State holds only **non-secret** wiring (snapshot ids, scope, project, port, repo url/ref).

---

## 6. State file

A repo-local JSON file (e.g. `scripts/orca-vm/<provider>-state.json`) threads non-secret values between
phases. Each script resolves values as **env var → state → built-in fallback**, and merges its outputs
back. Phase 2 writes the base `snapshotId`; Phase 3 overwrites it with the authenticated snapshot;
per-workspace `create` boots from `snapshotId`.

```json
{
  "baseName": "orca-base",
  "snapshotId": "snap_authenticated_image_id",
  "authSourceSnapshotId": "snap_base_image_id",
  "scope": "<provider-scope>",
  "project": "<provider-project>",
  "port": 7331,
  "repoUrl": "https://host/org/repo.git",
  "repoRef": "main",
  "projectRoot": "/abs/path/on/remote/repo"
}
```

---

## 7. Script templates (provider-agnostic shapes)

Scaffold under `scripts/orca-vm/`. These are **shapes** — fill in the provider's real commands. All
reserve stdout for the final JSON and log progress to stderr. Include a shared `json_value <key>` /
`env_value <NAME>` reader (env → state → fallback) in each.

**Where each script runs:**

- **Local-side** (`create`/`suspend`/`resume`/`destroy` + the base-snapshot/auth scripts the user
  invokes) runs **on the user's desktop**, so it must run on their OS. macOS/Linux: `#!/usr/bin/env
  bash`, `set -euo pipefail`, quoted paths. **Windows:** a bare `.sh` won't run — scaffold `.ps1`/`.cmd`
  or require WSL/Git-Bash and point `orca.yaml` at the right launcher.
- **Remote-side** (commands you `exec` *inside* the Linux VM) always runs in the VM's Linux shell, so
  bash is fine there regardless of the user's OS.

### 7a. Base-snapshot (`<provider>-base-snapshot.sh`) — Phase 2

```bash
#!/usr/bin/env bash
set -euo pipefail
# resolve base_name/repo_url/repo_ref/project_root/port/scope/project/timeout (env→state→fallback)
# resolve gh token: GH_TOKEN | GITHUB_TOKEN | `gh auth token`
# 1. provision a sandbox (timeout/vcpus/published port/snapshot retention); trap: remove on error
# 2. remote exec (long timeout): install pkgs + gh + corepack/pnpm + agent CLI;
#    clone with GIT_ASKPASS(token); write headless main-only build config;
#    dev setup; pnpm install; build CLI; build headless electron main; smoke-check tools
# 3. snapshot stopped sandbox; parse snapshot id (fail if unparseable)
# 4. merge { baseName, snapshotId, projectRoot, repoUrl, repoRef, port, scope, project } into state
# print only the state JSON to stdout
```

### 7b. Auth (`<provider>-base-auth.sh`) — Phase 3

```bash
#!/usr/bin/env bash
set -euo pipefail
# read source snapshot from state.snapshotId (fail if absent); auth_name="${base_name}-auth"
# 1. boot sandbox from source snapshot; trap: remove on error
# 2. INTERACTIVE/TTY remote exec: agent device/oauth login — user completes URL/code
# 3. verify login status; refuse to snapshot if not logged in
# 4. snapshot; parse new id
# 5. merge { snapshotId:<new>, authSourceSnapshotId:<source> } into state; remove auth sandbox
# print only the state JSON to stdout
```

### 7c. Create (`<provider>-create.sh`) — per workspace

```bash
#!/usr/bin/env bash
set -euo pipefail
# read authenticated snapshotId/scope/project/port/repo*/project_root (env→state→fallback)
# fail clearly if snapshotId is missing (point back to Phases 2–3)
# name = orca-${ORCA_VM_RECIPE_ID}-${ORCA_VM_INSTANCE_ID} (sanitized, length-capped)
# 1. boot sandbox from snapshotId with a published port; capture public URL → pairing address
#    trap: remove sandbox on error
# 2. remote exec: ensure repo at desired commit; rebuild only if commit changed (cache marker)
# 3. start `orca serve --port <port> --project-root <root> --pairing-address <addr> --recipe-json`
#    in the background; poll until it writes valid recipe JSON, then read it
# 4. print one object: { schemaVersion:1, pairingCode, projectRoot,
#    userData:{ provider, resourceId:name, snapshotId, port } }
```

### 7d. Suspend / resume / destroy — per workspace

```bash
#!/usr/bin/env bash
set -euo pipefail
payload="$(cat)"                       # Orca passes lifecycle JSON on stdin
resource_id="$(node -e 'const d=JSON.parse(process.argv[1]); process.stdout.write(d.recipeResult?.userData?.resourceId ?? "")' "$payload")"
[ -n "$resource_id" ] || { echo "No resource id in lifecycle payload" >&2; exit 1; }
# suspend: provider suspend "$resource_id"
# resume:  provider resume "$resource_id"; then RE-EMIT fresh recipe JSON (pairing may change)
# destroy: provider remove "$resource_id"   (or set destroy: none in orca.yaml)
```

### 7e. State file — scaffold with scope/project/repo filled in and snapshot ids empty (§6).

---

## 8. Per-workspace recipe contract (the fast path)

Once the authenticated snapshot exists, this runs on every workspace create. Define recipes in
`orca.yaml`:

```yaml
vmRecipes:
  - id: cloud-sandbox
    name: Cloud Sandbox
    create: ./scripts/orca-vm/cloud-sandbox-create.sh
    suspend: ./scripts/orca-vm/cloud-sandbox-suspend.sh
    resume: ./scripts/orca-vm/cloud-sandbox-resume.sh
    destroy: ./scripts/orca-vm/cloud-sandbox-destroy.sh
```

`create` runs **locally from the repo root**: boot the snapshot, ensure the repo is at the right commit,
start `orca serve` in the VM, then print **one** JSON object to stdout:

```json
{
  "schemaVersion": 1,
  "pairingCode": "orca-pairing-code-or-url",
  "projectRoot": "/absolute/path/to/repo/on/remote",
  "userData": { "provider": "example", "resourceId": "provider-resource-id" }
}
```

Required: `pairingCode` (from `orca serve --recipe-json`) and `projectRoot` (absolute remote path).
Optional: `schemaVersion` (`1`) and `userData` (non-secret provider metadata).

Lifecycle hooks (all run locally):

- `create`: required. Prints recipe result JSON.
- `suspend`: optional. Sleep; reads lifecycle payload on stdin.
- `resume`: optional. Wake; reads payload on stdin and **prints fresh recipe JSON** (pairing may change).
- `destroy`: optional unless `destroy: none`. Delete/cleanup; reads payload on stdin.

Start Orca remotely with `orca serve --host 0.0.0.0 --port "$PORT" --recipe-json`. If the provider
exposes a public URL, ensure the emitted pairing code points at the externally reachable address;
tunneling/port mapping is the script's job.

Backward compatibility: `command`→`create`, `cleanup`→`destroy`, `cleanup: none`→`destroy: none`.
Prefer the lifecycle names.

---

## 9. Doctor and validation

Validate in two stages — the cheap dry run first, then the live self-test.

### Dry run (free, non-destructive) — always do this first

`orca vm recipe doctor <recipe-id> --repo-path <repo> --json` validates **static wiring only** — it does
**not** boot anything. It checks: local-host execution (v1), repo path, recipe id exists,
create/destroy/suspend/resume command paths resolve, suspend/resume are paired, and each script is
executable (POSIX exec bit; skipped on Windows). Fix every failure here before spending any cloud money.

### Live self-test (`--provision`) — diagnose and iterate yourself

`orca vm recipe doctor <recipe-id> --repo-path <repo> --provision --json` actually runs the recipe end
to end: it executes `create`, validates the returned recipe JSON, then runs `destroy` to **tear the
environment back down** (so the test leaves nothing running, as long as `destroy` works). It spends real
cloud money, so get the user's OK **once** before starting — that one approval covers the whole loop
below; do not re-ask before each run.

On failure, the JSON result includes a `provisionTranscript` with the **complete** captured output of
each stage so you can self-diagnose without asking the user to relay logs:

```json
{
  "ok": false,
  "checks": [ { "id": "recipe.provision", "status": "fail", "message": "…" } ],
  "provisionTranscript": {
    "provision": { "exitCode": 0, "signal": null, "stdout": "…", "stderr": "…", "parseError": "…" },
    "destroy":   { "exitCode": 0, "signal": null, "stdout": "…", "stderr": "…" }
  }
}
```

**Run it as a loop:** read `provisionTranscript.provision.stderr` / `.stdout` / `.parseError` (and
`destroy.*`), fix the script, and re-run `--provision` until `ok` is `true` — iterating on your own
rather than waiting for the user to paste errors. Common reads: a non-empty `stderr` with `exitCode 0`
plus a `parseError` means `create` ran but printed something other than the single recipe-result JSON on
stdout (often a stray `echo` — route it to stderr, see §10); a non-zero `exitCode` is a provider/script
failure described in `stderr`. Each stream is redacted and capped (head+tail) — large logs keep both the
setup context and the failure.

The self-test cannot see provider-side truth beyond what the scripts print, so still confirm: state has a
populated **authenticated** `snapshotId` (Phases 2–3 done), and `destroy` is implemented/tested (or
explicitly `none` — in which case the self-test won't tear down, so clean up manually).

---

## 10. Failure modes

- **Build exceeds plan timeout (e.g. Hobby 45m).** Use enough vCPUs and a timeout covering the build;
  else split work or use a higher plan. The cap also limits per-workspace runtime — surface it.
- **Build exceeds plan RAM.** Build the **headless main only** (drop the renderer) — the biggest fitter.
- **Private-repo clone hangs/fails.** Wrong/missing token. Use `GIT_ASKPASS` + `GIT_TERMINAL_PROMPT=0`
  so it fails fast instead of prompting.
- **Snapshot expired/evicted.** If `create` hits an unknown snapshot id, rerun Phases 2–3 and update
  `snapshotId`.
- **Agent auth didn't persist.** Confirm `snapshotId` points at the **authenticated** snapshot; re-run
  Phase 3. Warn that short-lived tokens may need periodic re-auth.
- **Leaked paid resource.** Every long script must trap errors and remove the sandbox it created.
- **`create` emits non-JSON on stdout.** A stray `echo` corrupts the result — stdout is for the final
  JSON only; everything else to stderr. The `--provision` self-test surfaces this as `exitCode 0` + a
  `parseError` with the offending stdout in `provisionTranscript` (§9).

---

## 11. Boundaries

- Don't create accounts, choose plans/regions, or invent scope/project/org/image/billing ids.
- Don't invent or store credentials; no secrets in `userData`, state, comments, docs, or commits.
- Don't run paid/long phases (base snapshot, auth, live test) without an explicit OK.
- Don't hide provider errors behind generic messages — preserve actionable stderr.
- Don't make Orca own provider lifecycle beyond invoking the configured scripts.
- Don't commit or create an Orca workspace unless asked.
