# User-owned worker routing policy

Load this reference only when the user explicitly provides or asks for a custom worker routing policy or routing script. Without an explicit user policy, keep standard `ORCA orchestration worker-start` calls, provider defaults, worker counts, and task decomposition unchanged.

## Ownership boundary

- **Orca owns execution facts**: Run, Task, and Dispatch identity, workspace placement, terminal custody, liveness, and durable inbox delivery.
- **The user owns routing policy**: tier mapping (`simple` vs. `complex`), provider and profile ordering, model and effort preferences, denied-model patterns, live-worker caps, and external quota snapshots.
- Policy selection applies only after you have already decided to delegate a Task.
- Explicit user instructions for `--agent`, `--model`, or `--effort` always override policy defaults.
- Reusing a proven settled terminal (`--terminal <handle>`) keeps that terminal's existing session and workspace; never pass `--agent`, `--model`, or `--effort` to change a reused terminal's model.
- An external wrapper or pre-invocation guard that fails closed is a user-chosen policy pattern, not a built-in Orca runtime hook (do not conflate it with fail-open runtime hook proposals such as `#21747`).

## Reference example (`examples/orchestration-routing`)

Upstream ships an opt-in external wrapper and sample configuration at [`examples/orchestration-routing`](https://github.com/stablyai/orca/tree/main/examples/orchestration-routing):

```text
python route_worker.py \
  --policy-file policy.example.json \
  --tier simple|complex \
  --provider auto|<policy_provider> \
  --spec-file task.txt \
  --run <already-bound-run> \
  --worktree current \
  --quota-file quota-snapshot.example.json \
  [--state-dir <dir>] \
  [--dry-run]
```

- `--dry-run` prints the selected launch parameters and routing decision without starting a worker or writing local state; it does not print a fully resolved executable argv for `ORCA orchestration worker-start`.
- `--state-dir` selects where the wrapper stores dispatch outcome history. Auto-selection counts entries in the configured recent-dispatch window; this is not reservation state and does not lock concurrent invocations.
- **Policy file (`policy.example.json`)**: declares providers, tier profiles (`model`, `effort`), per-provider `denied_model_patterns`, and `max_live_workers` (for example `3` in the sample). Model names and denied patterns in the sample are illustrative user configuration, not global Orca defaults or recommendations.
- **Quota snapshot (`quota-snapshot.example.json`)**: records user-supplied observation timestamps, window usage, reset times, and cooldowns. Missing, unknown, or stale quota data is not assumed full or exhausted. A 100%-used window with a future reset remains blocked even if the snapshot is stale, and an active cooldown also remains blocked regardless of snapshot age. Stale 100% usage without a reset is unknown. There is no universal public auto-discovery API for provider quotas or account-bound preflight proof.
- Serialize wrapper invocations: `worker-list` liveness checking and the subsequent `worker-start` are not atomic, so concurrent calls can exceed the configured live-worker cap.
- This sample operates only on its execution host. It rejects remote-context environment settings and paired, SSH, or other remote-routing flags in `ORCA_CLI_COMMAND`. To use it with a remote execution host, run the script directly on that host.
