# Antigravity worker model selection

`orca orchestration worker-start --agent antigravity` (or `--agent agy`)
accepts `--model` and optional `--effort`. An effort requires a model; neither
option applies when attaching to an existing terminal.

Use `agy models` on the execution host to discover its current IDs. Orca does
not seed a model or assume the account's configured default. A requested model
without an effort emits only `--model`.

## Selection rules

Installed agy 1.2.7 was checked on macOS with these results:

| Model selector                          | Effort   | Result                                            |
| --------------------------------------- | -------- | ------------------------------------------------- |
| `gemini-3.7-flash-low`                  | `low`    | Accepted                                          |
| `gemini-3.7-flash-low`                  | `high`   | Rejected: conflict                                |
| `gemini-3.7-flash`                      | `high`   | Resolves to `gemini-3.7-flash-high`               |
| `gemini-3.6-flash` / `gemini-3.8-flash` | `medium` | Accepted                                          |
| `gemini-3.1-pro`                        | `medium` | Rejected: only low/high available                 |
| `Gemini 3.7 Flash (Low)`                | `high`   | Rejected: legacy selector does not support effort |

The launch catalog permits matching effort on canonical Gemini IDs ending in
`-low`, `-medium`, or `-high`. Verified Flash family aliases offer all three
levels; Gemini 3.1 Pro offers low/high. Other selectors can be passed as model-only
values, but Orca refuses an explicit effort until its supported levels are known.
Model availability remains the installed CLI's responsibility: a syntactically
valid ID is not proof that the execution host's account can use it.

Explicit worker selections replace model and effort flags in general agent
arguments. Model/effort flags embedded in a custom launcher are rejected rather
than silently defeating the requested selection. Existing argument quoting and
host routing apply on local, WSL, SSH and paired runtimes.

## Receipts and verification

`launch.requested` and `launch.effective` record launch selections, not a completed
model request. A model family alias remains an alias in the receipt. In the live
worker check, `gemini-3.7-flash` with High effort produced `ready / input_accepted`
and agy's rendered footer showed `Gemini 3.7 Flash · high`.

All accepted print-mode checks and the worker's generation then failed with
401 `ACCESS_TOKEN_TYPE_UNSUPPORTED`. They verify selection and delivery, not
successful generation, hook delivery or `worker_done`. Early startup logs can
mention the configured default before rejecting an invalid selection; those
lines alone are not selection proof.

Windows, Linux, WSL, SSH and paired-host execution were not live-tested for this
feature. Older hosts without the Antigravity catalog reject its worker model
options; no new RPC fields or status semantics are introduced. Mid-session
model/effort switching is not enabled by this launch catalog.
