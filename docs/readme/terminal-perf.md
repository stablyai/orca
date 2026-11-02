# Terminal perf suite

An on-demand Electron benchmark of terminal typing latency, frame timing,
output backpressure and hidden-pane restore. It drives the real renderer with
synthetic OpenCode-style redraw load across many panes and workspaces. It does
not run on PRs or on a schedule; run it before and after terminal rendering,
PTY, scheduler or xterm changes.

## Run locally

```sh
# Smaller suite: typing latency, foreground redraw, output scheduler, hidden TUI restore.
ORCA_BACKGROUND_LAUNCH=1 pnpm test:e2e:terminal-perf

# Scale suite with JSON report, budget check and HTML report.
npx electron-vite build --mode e2e
ORCA_BACKGROUND_LAUNCH=1 SKIP_BUILD=1 pnpm test:e2e:terminal-perf:scale:report
```

On Linux, wrap the commands in `xvfb-run --auto-servernum` to keep windows off
your desktop. Do not set `ORCA_E2E_TERMINAL_PERF_XVFB` locally: it presents
frames on a GitHub-hosted Xvfb display and throws anywhere else.

Pass Playwright arguments after `--`, for example
`pnpm test:e2e:terminal-perf:scale:report -- --grep "cross-workspace"`.

## Outputs

- `test-results/terminal-scale-perf-report.json`: the Playwright JSON report
  (change with `--report <path>` or `ORCA_E2E_TERMINAL_PERF_REPORT_PATH`).
- A summary table on stdout (`test:e2e:terminal-perf:summarize <report>`).
- A budget check (`test:e2e:terminal-perf:check-report <report>`); budgets live
  in `config/scripts/terminal-perf-report-budgets.mjs`.
- `test-results/terminal-perf-impact-report.html`
  (`ORCA_E2E_TERMINAL_PERF_HTML_REPORT_PATH`).

Compare reports from the base and candidate commits on the same machine; the
absolute numbers depend on hardware and display.

## Load knobs

| Variable                                        | Default        |
| ----------------------------------------------- | -------------- |
| `ORCA_E2E_OPENCODE_SCALE_PANES`                 | `10,25,50,100` |
| `ORCA_E2E_OPENCODE_SCALE_CROSS_WORKSPACE_PANES` | `10,25,50,100` |
| `ORCA_E2E_OPENCODE_SCALE_PRESSURE_PANES`        | `25,50`        |
| `ORCA_E2E_OPENCODE_SCALE_HIDDEN_PRESSURE_PANES` | `25`           |
| `ORCA_E2E_OPENCODE_FRAME_COUNT`                 | `60`           |
| `ORCA_E2E_OPENCODE_FRAME_INTERVAL_MS`           | spec default   |
| `ORCA_E2E_OPENCODE_PRESSURE_OUTPUT_CHARS`       | spec default   |

## Run in CI

Dispatch **Terminal Perf** (`.github/workflows/terminal-perf.yml`) from the
Actions tab or with `gh workflow run terminal-perf.yml -f ref=<branch>`. Its
inputs mirror the knobs above. It runs on a free GitHub-hosted runner and
uploads the JSON report, plus Playwright traces on failure.

The nightly schedule was removed on 2026-10-28. It had failed every night since
at least 2026-10-18 because the workflow ran on Blacksmith, which the
presented-frame guard rejects, and the JSON report hid the error.

The first hosted dispatch afterwards (run 40632739161) passed five scenarios.
It then failed "keeps active interactions responsive at 50 ACK-backpressured
OpenCode PTYs": the median typing latency was 104 ms against a 75 ms budget,
and the remaining scenarios were skipped. Reproduce locally before treating it
as a regression rather than a 4-vCPU runner limit.
