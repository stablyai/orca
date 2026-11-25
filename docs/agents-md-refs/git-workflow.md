# Git and Review Work

## Git Binary Compatibility

Orca runs the user's Git binary on native, WSL, and SSH hosts, which may all have different versions. Treat Git 2.25 as the core-workflow baseline.

## Git Scan Safety

- Never enumerate every ref and then run `git ls-tree -r` or `git show` once per ref. That ref × tree fan-out can retain gigabytes of output before a downstream `sort -u` or search can make progress.
- Prefer `rg` over the checked-out files for source searches. For history or refs, use a named ref, an explicit namespace/path, `--max-count`, and a bounded output; do not use an unqualified `--all` scan as a first diagnostic.
- Keep repository-wide commands targeted to the current repository and worktree. If an unbounded scan is genuinely required, measure the ref count first, explain the cost, and get confirmation before running it.

## Git Provider Compatibility

Source-control and review changes must consider GitLab and other supported git providers, not only GitHub. Keep provider-specific behavior behind explicit checks, and avoid GitHub-only naming for generic review concepts.

## GitHub CLI Usage

Be mindful of the user's `gh` CLI API rate limit — batch requests where possible and avoid unnecessary calls. All code, commands, and scripts must be compatible with macOS, Linux, and Windows.

## Merging Pull Requests

Before merging, verify that the required checks and aggregate gate in the full PR workflow have pass.

## Retrying GitHub Actions

Inspect a failed run with `gh run view <run-id> --log-failed --repo stablyai/orca`, then retry failed jobs with `gh run rerun <run-id> --failed --repo stablyai/orca`. GitHub also reruns jobs that depend on the failed jobs. In GitHub's UI, choose **Re-run failed jobs**; Orca offers **Rerun failed checks**.

Keep successful jobs unless there is a concrete reason to revalidate them, such as investigating runner-dependent flakiness. A full rerun restarts passing unit shards, packages, and platform checks too. If fixing the failure changes code, push the fix and validate the new commit; rerunning an older run still tests its original commit.

On a partial retry, the unit-selection plan or full set of shard artifacts may be absent for that attempt. Unit execution falls back to the full test inventory; incomplete selection evidence is advisory and cannot justify enabling selection. Inspect artifact requirements before retrying release or publishing jobs.
