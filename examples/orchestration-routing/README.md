# Optional Orca orchestration router

Requires Python 3.10+ (the script uses `|` union type syntax); the Orca CLI is required to start a worker. This standalone example reads a user-owned policy and caller-provided quota snapshot, checks workers in a pre-existing Orca Run, then explicitly calls Orca's existing `orchestration worker-start`. It is opt-in: it installs no hook, scheduler, or global policy. It uses Python's standard library and can run from Git or folder workspaces.

## Preview offline

From the repository root, this command prints a plan without calling Orca or a model and without writing router state:

```powershell
python -X utf8 .\examples\orchestration-routing\route_worker.py --tier simple --provider codex --dry-run --quota-file .\examples\orchestration-routing\quota-snapshot.example.json
```

On macOS or Linux:

```sh
python3 -X utf8 ./examples/orchestration-routing/route_worker.py --tier simple --provider codex --dry-run --quota-file ./examples/orchestration-routing/quota-snapshot.example.json
```

The checked-in profiles are examples selected for this configuration, not Orca global defaults or a model capability ranking. Edit a copy of `policy.example.json` and pass it with `--policy-file`. A model can start only when it appears in that provider's `profiles`; provider-specific `denied_model_patterns` take precedence. The sample denies AGY Flash and uses Argon medium/high without an extra effort value.

## Start a worker

Create the Run in Orca first. Put the complete Task spec in a UTF-8 text file with these five headings: `Target`, `Change`, `Constraints`, `Ownership`, and `Observable acceptance`. Then pass the existing Run ID, the desired configured provider (or `auto`), and the snapshot file:

```powershell
python -X utf8 .\examples\orchestration-routing\route_worker.py --tier complex --provider codex --run EXISTING_RUN_ID --worktree current --spec-file "C:\work space\task.md" --quota-file "C:\work space\quota-snapshot.json"
```

```sh
python3 -X utf8 ./examples/orchestration-routing/route_worker.py --tier complex --provider codex --run 'EXISTING_RUN_ID' --worktree current --spec-file '/work space/task.md' --quota-file '/work space/quota-snapshot.json'
```

Quotes are shell-specific: PowerShell uses double quotes for paths with spaces; POSIX shells use single quotes. The launcher passes each value as an argument, preserving UTF-8 text, Chinese, and quotes in the Task spec. `--worktree current` uses the active Git or folder workspace; this example does not create worktrees.

Before launch it pages through `worker-list --include-remote` for that same Run and refuses when liveness is unknown or the policy's `max_live_workers` is reached. The Run is never created by this script. It does not retry or clean up workers. A successful launch receipt is kept in full; the `launch.requested`/`launch.effective` comparison confirms only the recorded startup configuration, not the receiving account or model inference. Serialize wrapper invocations: the liveness check and following `worker-start` are separate, non-atomic operations, so concurrent invocations can exceed the worker cap.

Quota snapshots are caller-provided only. The example snapshot has unknown values. Missing, unknown, or stale quota data is not assumed to mean a pool is full or exhausted. A 100%-used window with a future reset remains blocked even if the snapshot is stale, and an active cooldown also remains blocked regardless of snapshot age. Stale 100% usage without a reset is treated as unknown. Add a source and observation time when entering usage or cooldown data. The router does not call quota APIs, read credentials, switch accounts, or use paid API billing. Router state is kept separately from Orca and Codex state; use `--state-dir` to choose another location. It stores dispatch outcome history only, with auto-selection counting successful and outcome-unknown entries within the configured recent-dispatch window. It does not create reservations or a lock. Dry runs never write state.

The router operates only on the execution host. It rejects remote-context environment settings (`ORCA_ENVIRONMENT`, `ORCA_PAIRING_CODE`, and `ORCA_REMOTE_PAIRING`) and paired, SSH, or other remote-routing flags in `ORCA_CLI_COMMAND`. To run on a remote host, start the script directly on that host; this example does not provide local SSH or paired placement. Orca's existing remote execution remains unchanged.

Google's [Antigravity FAQ](https://antigravity.google/docs/faq/) says wrapping the Antigravity CLI inside third-party coding agents or applications is not supported under consumer plans. The example's AGY profile is not a statement that Google authorizes or supports Orca worker routing; follow the terms and plan that apply to your account.

For this port, only the Windows Python unit tests and offline dry-run were run. macOS and Linux validation awaits CI; no real model invocation or remote-host validation was run for this port.
