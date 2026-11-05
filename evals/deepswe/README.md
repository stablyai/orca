# DeepSWE on subscription auth: setup notes

How to run [DeepSWE](https://deepswe.datacurve.ai) (Datacurve's long-horizon SWE benchmark, 113 tasks) locally against Claude Code and Codex, using the Claude and ChatGPT subscriptions instead of API keys. This file covers setup and method only; no results are recorded here.

## What is (and isn't) being evaluated

- **Measured:** a model together with the harness driving it. Each task runs in a fresh, network-restricted container; the agent must commit its work; only the committed diff is applied in a separate, clean verifier container.
- **Score:** `reward` is binary. It is 1 only if **all** fail-to-pass (F2P, new behavior) tests pass and no pass-to-pass (P2P, regression) tests break. `partial` / `f2p` fractions are diagnostic only.
- **Not comparable to the DeepSWE leaderboard.** The leaderboard runs every model in `mini-swe-agent` (one `bash` tool, fixed prompt) with API keys. Reusing subscription OAuth tokens in a third-party harness breaks the providers' terms, so this setup uses the official CLIs only.
- **Local deviations:** `--cpus ignore --memory ignore` (tasks request 8 GB each; the Docker Desktop VM here has ~8 GB).

## Harnesses

`run.sh` takes one of four agents:

| Agent             | Harness                                                                      | Auth                                            |
| ----------------- | ---------------------------------------------------------------------------- | ----------------------------------------------- |
| `claude`          | Stock Claude Code (Pier `claude-code`)                                       | Claude subscription (`CLAUDE_CODE_OAUTH_TOKEN`) |
| `codex`           | Stock Codex CLI (`subscription_codex.SubscriptionCodex`)                     | ChatGPT plan (`~/.codex/auth.json`)             |
| `claude-stripped` | Claude Code reduced to one shell tool (`stripped_agents.StrippedClaudeCode`) | Claude subscription                             |
| `codex-stripped`  | Codex reduced to one shell tool (`stripped_agents.StrippedCodex`)            | ChatGPT plan                                    |

### Stripped harnesses

The stripped agents approximate `mini-swe-agent` inside the official CLIs: one shell tool and the same short prompt (`stripped_system_prompt.md`) for both.

- **Claude Code:** `--tools Bash --strict-mcp-config --disable-slash-commands --system-prompt <prompt>`. (`--bare` would be simpler but refuses OAuth.) The init event in the trajectory confirms `tools: ['Bash']`, no MCP servers, no slash commands, no skills.
- **Codex:** a `config.toml` with `model_instructions_file` pointing at the prompt, `web_search = "disabled"`, `project_doc_max_bytes = 0`, `[features]` `view_image`, `multi_agent`, `apps`, `goals`, `memories` off, and `[skills.bundled] enabled = false`. Pier forces `--enable unified_exec`, so the shell tool stays. The prompt file is written into the container from Pier's skill-registration hook.
- Pier interpolates string CLI flags unquoted, so multi-word values are added by overriding `build_cli_flags` with `shlex.quote`.
- What can't be removed: each CLI's built-in agent loop, context handling and tool-call format.

## Where everything lives

Benchmark checkouts and outputs stay **outside** this repo:

```text
~/deepswe-eval/
  deep-swe/      datacurve-ai/deep-swe @ 0b9fabb (113 tasks, Harbor format)
  pier/          datacurve-ai/pier @ b26211e (installed as `pier` 0.3.1 via uv tool)
  claude.env     CLAUDE_CODE_OAUTH_TOKEN=...  (chmod 600, never commit)
  jobs/<job>/    per-job logs + per-trial dirs
```

In this repo (`evals/deepswe/`):

- `run.sh`: one entry point for every agent.
- `run_until_limit.sh`: runs one agent over the full suite and stops it on the first usage-limit hit.
- `subscription_codex.py`: Pier `Codex` subclass that adds `chatgpt.com` and `auth.openai.com` to the egress allowlist (stock Pier only allows `api.openai.com`, which blocks ChatGPT-plan traffic).
- `stripped_agents.py`, `stripped_system_prompt.md`: the stripped harnesses.
- `suite-16.txt`: a 16-task list of mid-sized tasks, one per line.

Per trial (`~/deepswe-eval/jobs/<job>/<task>__<id>/`): `agent/claude-code.txt` or `agent/codex.txt` (trajectory), `artifacts/model.patch` (graded diff), `verifier/reward.json`, `verifier/test-stdout.txt` (failure reasons), `result.json` (timing, tokens, API-price cost estimate).

## Setup from scratch (macOS)

1. Docker Desktop running (`open -a Docker`; check with `docker info`). Keep plenty of free disk (see Gotchas).
2. `brew install uv`
3. Clone and install:
   ```bash
   mkdir -p ~/deepswe-eval && cd ~/deepswe-eval
   git clone --depth 1 https://github.com/datacurve-ai/deep-swe
   git clone --depth 1 https://github.com/datacurve-ai/pier
   uv tool install ./pier
   ```
4. **Codex auth:** `codex login` with ChatGPT once on the host so `~/.codex/auth.json` has `auth_mode: chatgpt`. `run.sh` sets `CODEX_FORCE_AUTH_JSON=1` so Pier injects it.
5. **Claude auth:** run `claude setup-token` in your own terminal, then save only the `sk-ant-oat…` token:
   ```bash
   printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$(pbpaste | tr -d '[:space:]')" > ~/deepswe-eval/claude.env && chmod 600 ~/deepswe-eval/claude.env
   ```
   The token is a credential for your Claude account; revoke it from account settings when done. Never paste it into a chat.

## Running

```bash
evals/deepswe/run.sh codex  my-job                                   # default 4 tasks
evals/deepswe/run.sh claude my-job tomlkit-toml-table-converters     # specific tasks
EFFORT=medium CONCURRENCY=4 evals/deepswe/run.sh codex my-job $(cat evals/deepswe/suite-16.txt)
```

Full suite until the plan's usage limit, two agents on the same shuffled order:

```bash
SEED=0 EFFORT=medium CONCURRENCY=2 CLAUDE_MODEL=anthropic/claude-sonnet-5-5 \
  evals/deepswe/run_until_limit.sh claude-stripped full-stripped-sonnet
SEED=0 EFFORT=medium CONCURRENCY=2 \
  evals/deepswe/run_until_limit.sh codex-stripped full-stripped-terra
```

`run_until_limit.sh` checks the trajectories every 20 s for `usage_limit_reached` (Claude) or `hit your usage limit` (Codex), then interrupts Pier and removes that job's containers. Count trials that hit the limit as not run, not as failures.

Environment knobs: `CLAUDE_MODEL=` / `CODEX_MODEL=`, `EFFORT=` (default `high`), `CONCURRENCY=` (default 1), `SEED=` (deterministic task order), `DEEPSWE_EVAL_HOME=` (default `~/deepswe-eval`). Pass bare task names (`tomlkit-…`, not `datacurve/tomlkit-…`).

Summarize a job:

```bash
for t in ~/deepswe-eval/jobs/<job>/*/; do echo "$(basename $t) $(cat $t/verifier/reward.json 2>/dev/null)"; done
```

Browse trajectories: `pier view ~/deepswe-eval/jobs`.

## Gotchas

- **Disk fills up.** Pier builds a new image per trial (`<task>__<id>-main`, ~4–10 GB each) and never deletes it, plus build cache. A long run can fill the Mac's disk, after which Docker Desktop hangs and trials fail with `Environment start timed out`. Clean up between runs:
  ```bash
  docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '__[a-z0-9]{7}' | xargs -n 40 docker rmi -f
  docker builder prune -af
  ```
- `ANTHROPIC_BASE_URL` in your shell (the Claude desktop app sets one) makes Pier allowlist that host _instead of_ `api.anthropic.com`; `run.sh` unsets it for Claude agents.
- Task containers run in UTC, so reset times in limit messages are UTC.
- Starting Docker Desktop also restarts other stacks you had running (e.g. a local Supabase stack), which eats into the VM's memory.
- `cost_usd` in results is Pier's estimate at API list prices; on subscriptions you pay in rate-limit windows instead.

## Automating with Orca (not set up)

Orca's scheduled automations (`orca automations create --trigger <cron> --precheck <cmd>`) could start one run per usage window, with the precheck skipping the run unless Docker is up, disk is free and tasks remain. The benchmark itself should stay in a plain script: an automation runs an AI agent, which would spend the same subscription being measured. The Workflow Builder doesn't fit, since its steps are agent sessions rather than Pier runs.
