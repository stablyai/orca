# Failure modes

Load this when a doctor, provision, clone, login, or snapshot step failed. Each entry maps a
symptom to its cause; the rule that prevents it lives in the guide next to the step.

## Reading a failed `--provision` result

The JSON result carries a `provisionTranscript` with each stage's captured output, so you can
diagnose without asking the user for logs:

```json
{
  "ok": false,
  "checks": [{ "id": "recipe.provision", "status": "fail", "message": "…" }],
  "provisionTranscript": {
    "provision": { "exitCode": 0, "signal": null, "stdout": "…", "stderr": "…", "parseError": "…" },
    "destroy": { "exitCode": 0, "signal": null, "stdout": "…", "stderr": "…" }
  }
}
```

Streams are redacted and capped at both ends, keeping the start and the failure. Two common reads:

- A non-empty `stderr` with `exitCode 0` plus a `parseError` means `create` ran but printed something
  other than the single recipe-result JSON object on stdout. The offending stdout is in the
  transcript; the usual cause is a stray `echo`.
- A non-zero `exitCode` is a provider or script failure, described in `stderr`.

## Build and clone

- **Build exceeds the plan timeout**, for example Vercel Hobby's 45 minutes. Use enough vCPUs and a
  timeout that covers the build, or split the work, or move to a higher plan. The same cap limits
  per-workspace runtime, so surface it to the user.
- **Build exceeds plan RAM.** Building the headless main only, dropping the renderer, is the single
  biggest fit.
- **Private-repo clone hangs or fails.** The token is wrong or missing. `GIT_ASKPASS` plus
  `GIT_TERMINAL_PROMPT=0` makes it fail fast instead of prompting.
- **The `GIT_ASKPASS` helper aborts the clone with `$1: unbound variable`.** The `printf` or heredoc
  that wrote the helper inside `bash -lc` under `set -u` expanded `$1` and `$GH_TOKEN` at write time
  instead of leaving them for git-runtime. The same mistake writes the real token into the file.

## Agent auth

- **The agent verifies as "not logged in" despite a good login.** `codex login status` and similar
  print their success line to stderr, so a check that reads stdout only misses it.
- **A headless agent login hangs.** Plain OAuth `login` started a loopback callback server on a port
  the host browser cannot reach.
- **Agent auth did not persist.** Confirm `snapshotId` points at the authenticated snapshot rather
  than the base, and re-run the auth phase. If the agent's credentials are short-lived, the snapshot
  needs periodic re-auth; warn the user.
- **Agent auth copied from the host breaks.** A bind-mounted or copied host agent home carries sqlite
  files that can be unwritable or host-specific, hooks that need approval again, and config that
  references local-only environment variables. Authenticate inside the runtime and snapshot or commit
  that layer instead.

## Environment lifecycle

- **`known_hosts` host-key churn on local Docker.** Each ephemeral container regenerated its own SSH
  host key, and they collide on `127.0.0.1` as the published port rotates.
- **Snapshot expired or evicted.** `create` hit an unknown snapshot id. Re-run the base and auth
  snapshot phases and update `snapshotId` in state.
- **Docker auth image exits immediately.** Read `docker image inspect … .Config.Entrypoint` and
  `docker logs`. An image committed from an interactive shell keeps that shell as its entrypoint.
- **A paid resource leaked.** A long script created an environment and then failed without a trap
  that removes it.
