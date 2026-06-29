---
name: ephemeral-vms
description: >-
  Set up, review, debug, or validate Orca ephemeral VM recipes for cloud
  sandboxes and one-workspace remote runtimes — including the full first-time
  setup (provider prerequisites, the reusable base snapshot, the coding-agent
  auth snapshot, and credential/state management), not just the per-workspace
  lifecycle scripts. Use when the user wants to stand up ephemeral coding VMs,
  fix a `vmRecipes` entry in `orca.yaml`, scaffold provider lifecycle scripts,
  or resolve an `orca vm recipe doctor` failure.
---

# Ephemeral VMs

Use this skill to help a user stand up and maintain a repo-owned ephemeral VM recipe end to end.

Orca stays a **thin wrapper**. You guide and scaffold; you never own the user's cloud account,
billing, images, or credentials. Concretely:

- **You DO:** make the required setup explicit and sequenced, detect what is detectable (provider
  CLI present? logged in? recipe present? `doctor` passing?), scaffold provider-templated scripts
  the user fills in, drive the slow snapshot/auth phases with the user, and always show the exact
  next action.
- **You DO NOT:** create cloud accounts, choose plans, pick regions, invent org/project/scope ids,
  store or print secrets, or run anything that spends money without an explicit user OK.

First-time setup has **four phases before the per-workspace recipe even runs**. These are easy to
miss, so make them explicit and walk them in order:

1. **Prerequisites** — cloud account, provider CLI, scope/project, plan limits, git token.
2. **Base snapshot** — the reusable image: tools + repo + headless build, snapshotted once.
3. **Agent-auth snapshot** — boot the base, run interactive device-auth for the coding agent, re-snapshot.
4. **State** — thread snapshot id / scope / project / port between phases via a state file.

Only then does the **per-workspace recipe contract** (create/suspend/resume/destroy) work fast.

---

## 1. Setup Workflow

Drive these steps with the user. Steps marked **[CHECKPOINT]** require explicit confirmation before
proceeding because they spend cloud money, take a long time, or need the user at the keyboard.

1. **Inspect the repo.** Look for an existing `orca.yaml` `vmRecipes` entry, a `scripts/orca-vm/`
   folder, a state file, Dockerfiles, devcontainer config, and README setup notes. If a working
   recipe already exists, jump to Doctor (section 9) instead of rebuilding.
2. **Pick the provider.** Ask which cloud sandbox/VM provider to use if the repo doesn't make it
   obvious (e.g. Vercel Sandbox, Fly, Modal, a raw cloud VM). Ask which coding agent CLI runs in the
   VM (e.g. `codex`, `claude`).
3. **Check prerequisites (Phase 1).** Detect provider CLI presence and auth; confirm scope/project,
   plan/timeout limits, and a git token source. Do not guess any of these — ask. (Section 2.)
4. **Scaffold the scripts and state file.** Write `scripts/orca-vm/<provider>-*.sh` plus the state
   file from the templates in section 7, filling in the provider's real commands. Make scripts
   executable. Do not commit unless asked.
5. **[CHECKPOINT] Build the base snapshot (Phase 2).** Confirm with the user before running — it
   provisions a paid sandbox and takes ~25 min. Then run the base-snapshot script and store the
   resulting snapshot id in state. (Section 3.)
6. **[CHECKPOINT] Authenticate the agent (Phase 3).** Confirm the user is at the keyboard, then run
   the auth script. It boots the base snapshot and starts an **interactive** device-auth — the user
   follows a URL/code in the agent's output. Verify login, then re-snapshot. (Section 4.)
7. **Wire the recipe.** Ensure `orca.yaml` `vmRecipes` points create/suspend/resume/destroy at the
   per-workspace scripts. (Section 8.)
8. **Doctor.** Run `orca vm recipe doctor <recipe-id> --repo-path <repo>` for non-destructive
   validation. (Section 9.)
9. **[CHECKPOINT] Optional live test.** Only if the user explicitly asks: create a workspace via
   Orca's `Run on → Ephemeral VM` picker, then verify sleep/wake/delete invoke the expected provider
   lifecycle. This spends cloud money.

Never create an Orca workspace or commit changes unless the user explicitly asks.

---

## 2. Phase 1 — Prerequisites checklist

These are the user's responsibility; you verify what's verifiable and ask for the rest. Nothing here
should be invented.

- **Cloud account** with the chosen provider, on a plan that allows sandboxes/VMs. Ask the user to
  confirm.
- **Provider CLI installed and authenticated.** Detect it (`command -v <cli>`), and check auth with
  the provider's status command (e.g. `vercel whoami`). If missing, point the user at the provider's
  install/login docs — do not log them in for them.
- **Scope / project / region.** The org/team scope and project the sandboxes live under. Ask; never
  guess. These flow into every script via the state file.
- **Plan / timeout / RAM limits.** Record the plan's caps. Example: Vercel Hobby caps sandbox
  timeout at **45m**, which constrains both the long base build and per-workspace runtime. If the
  build won't fit, see Failure modes (section 10).
- **Git token for private repos.** A `GH_TOKEN` / `GITHUB_TOKEN` (or the provider's own git auth) so
  the VM can clone the repo. See Credentials (section 5). If `gh` is installed locally, the script
  can fall back to `gh auth token`.
- **Coding agent CLI choice** (e.g. `codex`, `claude`) and confirmation the user has an account for
  it — the agent gets authenticated into the VM in Phase 3.

State explicitly which items you verified vs. which the user asserted, so nothing silent blocks them
later.

---

## 3. Phase 2 — Base snapshot (the slow reusable image)

Build it **once**, snapshot it, and every workspace boots from the snapshot in seconds instead of
rebuilding. Provisioning + building takes a while (often ~20–30 min, depending on the repo and the
provider's vCPUs), so it runs behind a checkpoint.

What the base-snapshot script does, in order:

1. Provision a fresh sandbox (named, with the plan-appropriate `--timeout`, vCPUs, and a published
   port for `orca serve`). Set a snapshot expiration/retention policy if the provider supports one.
2. Install system packages the headless runtime needs (the ~30 libs for a headless Electron main:
   X/GTK/NSS/mesa libs, build toolchain, `python3`, `git`, etc.), plus the provider/git CLI (`gh`),
   `corepack`/`pnpm`, and the coding agent CLI. Use the VM image's package manager — `apt`, `dnf`,
   or `apk` depending on the base distro, which is determined by the provider/image, not the provider
   brand.
3. Clone the repo at the target ref using the git token (section 5).
4. Write a **headless serve build config** — build only the Electron **main** process, not the
   desktop renderer, so the build fits in plan RAM. (Reuse the desktop config's `main` field; drop
   `renderer`.)
5. Run dev setup, install deps, build the CLI, and build the headless Electron main.
6. Smoke-check the toolchain (`gh --version`, agent `--version`, `orca serve --help`).
7. **Snapshot** the stopped sandbox and **parse the snapshot id** from CLI output.
8. Write the snapshot id + scope/project/port/repo info to the state file (section 6).

**[CHECKPOINT] before running:** confirm the user accepts the cost and ~25 min wait. Wrap the build
in an error trap that removes the half-built sandbox on failure so a crash doesn't leave a paid
resource running. Keep stdout for the final state JSON; send all progress to stderr.

---

## 4. Phase 3 — Agent-auth snapshot (interactive device-auth, then re-snapshot)

The base snapshot has the agent CLI installed but **not logged in**. Per-workspace VMs are ephemeral,
so logging in each time is impractical — instead, log the agent in once and bake the credentials into
a second snapshot layer.

What the auth script does:

1. Boot a sandbox **from the base snapshot id** (read from state).
2. Run the agent's **device/OAuth login interactively** (`--interactive --tty` exec). The agent prints
   a URL + code; **the user must complete it in their browser.** This is the human-in-the-loop step.
3. **Verify** the login succeeded (e.g. the agent's `login status` command); refuse to snapshot an
   unauthenticated VM.
4. **Re-snapshot** the now-authenticated sandbox and parse the new snapshot id.
5. Update the state file so `snapshotId` now points at the **authenticated** snapshot (record the
   base id it derived from too). Remove the stopped auth sandbox.

**[CHECKPOINT] before running:** confirm the user is present to complete the browser auth. If the
agent's credentials are short-lived, warn that the snapshot may need periodic re-auth (section 10).

After this phase, `snapshotId` in state is the **authenticated** image that per-workspace `create`
boots from.

---

## 5. Credentials strategy

- **Never** commit secrets, and never put them in `userData`, recipe JSON, comments, docs, or the
  state file.
- **Git token (private repos):** read from the environment (`GH_TOKEN` / `GITHUB_TOKEN`), falling
  back to `gh auth token` if `gh` is logged in locally. Pass it to the remote only via the provider's
  ephemeral `--env` mechanism. Inside the VM, prefer a `GIT_ASKPASS` helper script using
  `x-access-token` + the token over embedding the token in the clone URL, and set
  `GIT_TERMINAL_PROMPT=0` so a missing token fails fast instead of hanging.
- **Provider auth:** rely on the provider CLI's own logged-in session (scope/project flags), not
  checked-in keys.
- **Agent auth:** lives inside the authenticated snapshot from Phase 3, established by interactive
  device-auth — it is never a file you write or commit.
- The state file holds only **non-secret** wiring (snapshot ids, scope, project, port, repo url/ref).

---

## 6. State file

A single repo-local JSON file (e.g. `scripts/orca-vm/<provider>-state.json`) threads non-secret
values between phases. Each phase reads it for defaults and merges its outputs back in. Every value
should also be overridable by an env var so the scripts are testable and CI-friendly.

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
  "projectRoot": "/abs/path/on/remote/repo",
  "snapshotCreatedAt": "ISO-8601",
  "authSnapshotCreatedAt": "ISO-8601"
}
```

Resolution pattern in every script: **env var → state file value → built-in fallback.** Phase 2
writes `snapshotId` (base); Phase 3 overwrites `snapshotId` with the authenticated snapshot and
records `authSourceSnapshotId`. Per-workspace `create` reads `snapshotId` and boots from it.

---

## 7. Script templates (provider-agnostic shapes)

Scaffold these under `scripts/orca-vm/`. They are **shapes**, not a copy of any one provider — fill
in the provider's real commands. All keep stdout reserved for the final JSON and log progress to
stderr.

**Where each script runs (this drives the language choice):**

- **Local-side** — `create`, `suspend`, `resume`, `destroy`, plus the base-snapshot and auth scripts
  the user invokes — run **on the user's desktop**. So they must run on the user's OS. On macOS/Linux,
  `#!/usr/bin/env bash` with quoted paths and `set -euo pipefail` is fine. **On Windows**, a bare
  `.sh` won't run: either scaffold `.ps1`/`.cmd` equivalents, or require WSL/Git-Bash and detect it
  (and have `orca.yaml` point at the right launcher). Don't assume bash on the desktop.
- **Remote-side** — the commands you `exec` *inside* the Linux VM (package install, clone, build,
  device-auth) — always run in the VM's Linux shell, so bash there is fine regardless of the user's OS.

**Shared helpers** (include in each script): a `json_value <key> [fallback]` reader over the state
file and an `env_value <NAME> <fallback>` reader, used as `env → state → fallback`.

### 7a. Base-snapshot script (`<provider>-base-snapshot.sh`) — Phase 2

```bash
#!/usr/bin/env bash
set -euo pipefail
# resolve repo_root, state_path; define json_value / env_value
# base_name, repo_url, repo_ref, project_root, port, scope, project, timeout from env→state→fallback
# resolve gh token: GH_TOKEN | GITHUB_TOKEN | `gh auth token`

# 1. provision a fresh sandbox (timeout/vcpus/published port/snapshot retention) → stderr
# trap: on error, remove the half-built sandbox so no paid resource leaks
# 2. remote exec (long timeout): install system pkgs + gh + corepack/pnpm + agent CLI
#    clone repo with GIT_ASKPASS(token); write headless main-only build config;
#    run dev setup; pnpm install; build CLI; build headless electron main; smoke-check tools
# 3. snapshot the stopped sandbox; parse snapshot id from CLI output (fail if unparseable)
# 4. merge { baseName, snapshotId, projectRoot, repoUrl, repoRef, port, scope, project, ts } into state
# print only the state JSON to stdout
```

### 7b. Auth script (`<provider>-base-auth.sh`) — Phase 3

```bash
#!/usr/bin/env bash
set -euo pipefail
# read source_snapshot_id from state.snapshotId (fail if absent)
# auth_name = "${base_name}-auth"
# 1. boot sandbox from source_snapshot_id (published port)
# trap: remove auth sandbox on error
# 2. INTERACTIVE/TTY remote exec: run agent device/oauth login — user completes URL/code
# 3. verify login status; refuse to snapshot if "not logged in"
# 4. snapshot; parse new snapshot id
# 5. merge { snapshotId: <new>, authSourceSnapshotId: <source>, authTs, agentAuthenticated:true } into state
#    remove stopped auth sandbox
# print only the state JSON to stdout
```

### 7c. Create script (`<provider>-create.sh`) — per workspace

```bash
#!/usr/bin/env bash
set -euo pipefail
# read snapshotId (authenticated), scope, project, port, repo*, project_root from env→state→fallback
# fail clearly if snapshotId is missing (point the user back to Phases 2–3)
# name = orca-${ORCA_VM_RECIPE_ID}-${ORCA_VM_INSTANCE_ID} (sanitized, length-capped)
# 1. boot sandbox from snapshotId with a published port; capture the public URL → derive pairing address
# trap: remove sandbox on error
# 2. remote exec: ensure repo at desired commit/ref; rebuild only if commit changed (cache marker file)
# 3. start `orca serve --port <port> --project-root <root> --pairing-address <addr> --recipe-json`
#    in the background; poll until it writes valid recipe JSON, then read it
# 4. merge serve JSON with { schemaVersion:1, projectRoot, userData:{ provider, resourceId:name,
#    baseName, snapshotId, port, pairingAddress } } and print that single object to stdout
```

### 7d. Suspend / resume / destroy (`<provider>-suspend.sh` etc.) — per workspace

```bash
#!/usr/bin/env bash
set -euo pipefail
payload="$(cat)"                       # Orca passes lifecycle JSON on stdin
resource_id="$(node -e 'const d=JSON.parse(process.argv[1]); process.stdout.write(d.recipeResult?.userData?.resourceId ?? "")' "$payload")"
[ -n "$resource_id" ] || { echo "No resource id in lifecycle payload" >&2; exit 1; }
# suspend: provider suspend "$resource_id"
# resume:  provider resume "$resource_id"; then RE-EMIT fresh recipe JSON (endpoint/pairing may change)
# destroy: provider remove "$resource_id"   (or set destroy: none in orca.yaml if cleaned elsewhere)
```

### 7e. State file (`<provider>-state.json`)

See section 6. Scaffold it with the user's scope/project/repo filled in and snapshot ids left empty;
Phases 2 and 3 populate them.

---

## 8. Per-workspace recipe contract (the fast path)

Once the authenticated snapshot exists, this is what runs on every workspace create. Define recipes
in `orca.yaml`:

```yaml
vmRecipes:
  - id: cloud-sandbox
    name: Cloud Sandbox
    create: ./scripts/orca-vm/cloud-sandbox-create.sh
    suspend: ./scripts/orca-vm/cloud-sandbox-suspend.sh
    resume: ./scripts/orca-vm/cloud-sandbox-resume.sh
    destroy: ./scripts/orca-vm/cloud-sandbox-destroy.sh
```

`create` runs **locally on the user's desktop from the repo root**. It boots the snapshot, ensures the
repo is at the right commit, starts `orca serve` in the remote runtime, then prints **one** JSON
object to stdout:

```json
{
  "schemaVersion": 1,
  "pairingCode": "orca-pairing-code-or-url",
  "projectRoot": "/absolute/path/to/repo/on/remote",
  "userData": { "provider": "example", "resourceId": "provider-resource-id" }
}
```

Required: `pairingCode` (the code/URL from `orca serve --recipe-json`) and `projectRoot` (absolute
repo path on the remote). Optional: `schemaVersion` (use `1`) and `userData` (non-secret provider
metadata for lifecycle hooks).

Lifecycle hooks:

- `create`: required. Runs locally, prints recipe result JSON.
- `suspend`: optional. Runs locally when Orca sleeps the workspace; reads lifecycle payload on stdin.
- `resume`: optional. Runs locally when Orca wakes the workspace; reads payload on stdin and **prints
  fresh recipe result JSON** (endpoint/pairing may change after waking).
- `destroy`: optional unless `destroy: none`. Runs locally on delete/cleanup; reads payload on stdin.

Backward compatibility: `command` maps to `create`, `cleanup` maps to `destroy`, `cleanup: none`
maps to `destroy: none`. Prefer the lifecycle names for new work.

When starting Orca remotely, prefer recipe-friendly serve:

```bash
orca serve --host 0.0.0.0 --port "$PORT" --recipe-json
```

If the provider exposes the server through a public URL, make sure the emitted pairing code/URL
points at the externally reachable address; tunneling/port mapping belongs in the user's script.

---

## 9. Doctor and validation

Run `orca vm recipe doctor <recipe-id> --repo-path <repo>` (IPC `ephemeralVm:doctor`). It is
**non-destructive** and only validates static recipe wiring — it does **not** boot a VM, check
snapshots, or verify auth. It checks:

- recipes run on the local desktop host (v1),
- the repo path exists,
- the recipe id exists in `vmRecipes`,
- the `create` command path resolves (warns on absolute / non-repo-relative paths; fails if missing),
- `destroy` is configured or explicitly `destroy: none` (warns otherwise),
- the `suspend` and `resume` command paths resolve when set, and warns if only one of the pair is
  defined (a workspace suspended without a resume cannot be woken),
- each referenced script is executable (POSIX `chmod +x`; this check is skipped on Windows, where the
  exec bit does not apply).

Because doctor can't see the snapshot/auth state, also confirm manually:

- `create` (and `resume`, if set) print valid recipe JSON on stdout; logs/errors go to stderr.
- `pairingCode` present and not logged elsewhere; `projectRoot` is an absolute remote path.
- The state file has a populated **authenticated** `snapshotId` (Phases 2–3 completed).
- Credentials come from env/provider CLI auth, never checked-in files.
- Destroy is implemented and tested, or explicitly `none`.

---

## 10. Failure modes

- **Build exceeds plan timeout (e.g. Hobby 45m).** Provision the base sandbox with enough vCPUs and a
  timeout that covers the ~25 min build; if it still won't fit, split work or use a higher plan. The
  same cap limits per-workspace runtime — surface it to the user.
- **Build exceeds plan RAM.** Build the **headless Electron main only** (drop the renderer bundle).
  This is the single biggest fitter for low-RAM plans.
- **Private-repo clone fails / hangs.** Missing or wrong git token. Verify `GH_TOKEN`/`GITHUB_TOKEN`
  or `gh auth token`; use a `GIT_ASKPASS` helper and `GIT_TERMINAL_PROMPT=0` so it fails fast instead
  of hanging on a credential prompt.
- **Snapshot expired / evicted.** Snapshots have retention/expiration. If `create` fails with an
  unknown snapshot id, rerun Phases 2–3 to rebuild and re-auth, then update `snapshotId` in state.
- **Agent auth didn't persist.** If workspaces start unauthenticated, the agent's tokens are
  short-lived or the auth snapshot wasn't the one `create` boots from. Confirm `snapshotId` points at
  the **authenticated** snapshot, and re-run Phase 3 to refresh; warn the user this may be periodic.
- **Half-built paid resource leaked.** Every long-running script must trap errors and remove the
  sandbox it created, so a failed build doesn't bill silently.
- **`create` emits non-JSON on stdout.** Any stray `echo` to stdout corrupts the recipe result. Keep
  stdout for the final JSON object only; route everything else to stderr.

---

## 11. Boundaries

- Do not create cloud accounts, choose plans/regions, or invent scope/project/org/image/billing ids.
- Do not invent or store credentials; never put tokens, pairing material, or private keys in
  `userData`, the state file, comments, docs, or commits.
- Do not run paid or long-running phases (base snapshot, auth, live test) without an explicit
  user OK.
- Do not hide provider errors behind generic messages; preserve actionable stderr.
- Do not make Orca responsible for provider lifecycle beyond invoking the configured scripts.
- Do not commit changes or create an Orca workspace unless the user explicitly asks.
