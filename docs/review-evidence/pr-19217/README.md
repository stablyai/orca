# Structured worktree status validation

Validated on September 7, 2026 in a background Electron dev instance of
`pr19217-review-r2`, based on `ce1024096b` with the source-adapter refactor.
CDP app identity confirmed the checkout; screenshots show the full hidden renderer.
The command output is the real `orca worktree ps --json` response reduced to status,
agent state, provider, and pane key for readability.

## Functional correctness

A real Codex structured session appeared as `working` in `worktree.ps` while the
sidebar showed working. Closing its chat tab removed that exact session's row and
returned the worktree to `active`. A different completed chat remained present,
confirming that closure removed only the selected session.

- [Working: CLI and sidebar](working.png)
- [Closed: CLI and sidebar](closed.png)

The disappearing session is `codex_40677067_f492_4d7d_86dd_ec566ede04c3`.
The host's held-session roster controls eligibility; its retained broadcast cache
is history, not a roster. Failed eviction intentionally keeps an entry for retry.

## Architecture

PTY reconciliation and process admission belong to the PTY source adapter.
Structured input comes from the current host's held-session projections. One
admitted collection feeds row shaping and worktree aggregation, with no structured
boolean bypass. PTY hooks and retained reports still arrive independently, so their
precedence and conservative remote evidence rules remain necessary. No second
persistent status store or provider polling was introduced.

## Validation and limits

Independent final review found no proven issues. Runtime, host lifecycle, status
feed and source-admission suites passed: 1,344 tests, one skipped. Node typecheck,
targeted lint and diff checks passed. Ablating the runtime call to enumerate
retained history caused the executable call-site test to fail with two rows where
one was expected; restoring the live accessor passed both call-site tests.

Live screenshots prove Codex working and closure on macOS. Claude provider turns,
approval/input states, live Windows/Linux/WSL/SSH/relay/mobile scenarios and
release-scale latency/heap measurements remain unverified. Existing tests cover
remote/WSL evidence, monitoring precedence and lifecycle cases. The existing
30-minute freshness rule and CLI activity timestamps are preserved; complete
CLI/sidebar timing parity is not claimed. The wire keeps its existing row shape
and status vocabulary; mobile receives the new rows without a new opcode.
