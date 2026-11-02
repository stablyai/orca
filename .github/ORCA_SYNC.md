# Syncing Orca into Phorca

**Sync Orca release** runs daily at 00:23 UTC. It selects the
highest stable desktop release (`vX.Y.Z`) from `stablyai/orca` published at
least 72 hours earlier. Drafts, prereleases and mobile versions are excluded.
GitHub may delay scheduled runs.

The workflow maintains one open PR into Phorca's default branch (`main`), using
`codex/AI-101-orca-release-sync`. Review and merge it yourself. It brings in
Orca source changes, preserving Phorca customizations through a normal merge.
It keeps `.github/workflows/` exactly as they are in Phorca's default branch;
review Orca's workflow updates manually. The generated PR links to those files.
The workflow does not run AI or treat Codex and Claude differently.

## Single-workflow policy

Phorca keeps only `sync-orca-release.yml` in `.github/workflows/`. Other upstream
workflows are intentionally removed, not archived or guarded with fork-specific
conditions. Git history retains them if a maintainer later chooses to restore one.

Use this sync for upstream updates: it restores the entire workflow directory
from Phorca's default branch, excluding upstream workflow additions, edits and
deletions. It also keeps the exact test paths in
[`config/phorca-retired-tests.json`](../config/phorca-retired-tests.json) deleted,
resolving upstream modify/delete conflicts on those paths before checking for
other conflicts. Direct upstream merges do not have either protection.

The retirement list covers selected `config/scripts/*.test.mjs` suites, not the
whole directory or every test matching that suffix. Additions to upstream tests
are not automatically excluded. Keep every listed file deleted on Phorca's
default branch; retire another test by deleting it and adding its exact path
through review. To restore one, remove its entry and restore the test through
review.

This workflow opens or updates a source-sync PR. It does not publish Phorca
builds or run PR, build, deployment or security-check workflows. Retiring mixed
test suites also removes their remaining script, build and runtime coverage.
Production scripts, surviving tests and `.test.ts` files continue merging
upstream changes normally; surviving tests remain available locally, not as
automatic PR gates.

New sync PRs request recorded local verification commands, results and any
remaining gaps; they do not imply that automatic PR checks ran.

Run the sync regressions locally before changing the update mechanism:

```sh
pnpm test config/scripts/sync-orca-release.test.mjs config/scripts/sync-orca-release-api.test.mjs
```

## Enable it

1. Keep repository-wide Actions disabled while preparing and merging the
   single-workflow cutover. Do not enable Actions just to inspect the workflows.
2. List registered workflows with
   `gh api repos/phocassoftware/phorca/actions/workflows --paginate`.
   Disable every registered `.github/workflows/` entry except
   `sync-orca-release.yml` using
   `gh workflow disable WORKFLOW_ID --repo phocassoftware/phorca`.
   Leave GitHub-managed Copilot and Dependabot entries alone. Check each command
   succeeds; stop activation on any failure. Old branches and tags retain their
   YAML, so deleting files on `main` alone is insufficient.
3. Merge the cutover through the normal approved PR process. Verify the default
   branch contains only the sync workflow, then recheck the registrations and
   disable any other checked-in workflow discovered after the merge.
4. In **Settings → Actions → General → Workflow permissions**, enable
   **Allow GitHub Actions to create and approve pull requests**, if not already
   allowed. Organization policy must allow it. The workflow grants
   `contents: write` and `pull-requests: write` to the provided `GITHUB_TOKEN`;
   no broader token defaults are needed.
5. Enable sync with
   `gh workflow enable sync-orca-release.yml --repo phocassoftware/phorca`.
   Remove `ORCA_SYNC_PAUSED` or set it to `false` to allow scheduled updates.
6. Enable repository-wide Actions **last**, without broadening the allowed
   action dependencies. Verify only sync is active among checked-in workflows.
7. Run it once from the default branch:
   `gh workflow run sync-orca-release.yml --ref main --repo phocassoftware/phorca`.
   Inspect the job log and resulting PR or no-op explanation; a successful run
   with a skipped sync job is not proof. A manual run does not prove scheduling.

No custom token or repository secret is needed. See
[GitHub's token documentation](https://docs.github.com/en/actions/concepts/security/github_token)
and [PR creation settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#preventing-github-actions-from-creating-or-approving-pull-requests).
The sync job executes only the script from Phorca's default branch, disables
Git hooks, and does not install dependencies or execute upstream code.

## Use it

- **Merge with “Create a merge commit.”** Squash/rebase loses the Orca history
  needed to recognize versions already included in Phorca. Enable merge commits
  in the repository settings if necessary. After merging, the next update gets a
  new PR on the same branch; there is only one open sync PR at a time.
- Set repository variable **ORCA_SYNC_PAUSED=true** to pause scheduled updates.
  Remove it or set it to `false` to resume. Manual runs remain available.
- Use **Run workflow** with an optional stable release tag to bypass the
  72-hour wait. A release older than the PR's selected version is not merged,
  even from a divergent upstream branch. Workflow and retired-test policy can
  still be refreshed on an existing PR. Releases already in Phorca need no new PR.
  Always select Phorca's default branch in **Use workflow from**; other branches
  and tags are rejected. The release is chosen with the separate `tag` input.
- Closing an unmerged sync PR pauses updates until a manual run reopens it.
- Resolve conflicts and push fixes on the PR branch. Fixes outside the retired
  test paths survive subsequent updates. If a later update conflicts, the
  workflow reports failure and preserves the remote branch. Resolve it manually
  and retry.
- Reviewed workflow changes on the pending PR pause further sync updates until
  that PR is merged, so a scheduled run cannot overwrite its CI fixes.
- Review and apply workflow edits separately to Phorca's default branch. The
  next sync refreshes the PR's workflow files from that branch, even if no new
  Orca release is eligible. Upstream workflow additions, edits and deletions are
  all excluded, and conflicts confined to those files do not block updates.
- Listed retired tests remain deleted on new and existing update branches,
  including after later upstream edits to those files. Policy-only refreshes
  also run when the release API returns no eligible candidate, keeping the PR's
  selected-release title/body and upstream source unchanged. Other test files
  merge normally and can still require manual conflict resolution.
- With no eligible release and no existing unmerged sync branch, nothing is
  created. Closing an unmerged PR still pauses scheduled updates; a manual run
  can resume it without waiting for an eligible release.

The first PR can show merge conflicts with Phorca. Review them and run relevant
local checks before merging. Organization-required reviews still apply.
Updates use force-with-lease so a concurrent human push cannot be overwritten.
No automatic merge is performed.
If pushing an update succeeds but updating its PR details fails, rerun the
failed workflow with the same inputs. It repairs the title and release
description without another push.

## Pause or roll back

`ORCA_SYNC_PAUSED=true` pauses scheduled updates, not manual dispatches. Disable
the sync workflow or repository-wide Actions to stop new runs entirely. Disabling
a workflow does not cancel existing runs; inspect and cancel unwanted queued or
running jobs separately.

If reverting the cutover, disable repository-wide Actions first, then revert the
source change through review. Restore and enable only workflows a maintainer
explicitly chooses; do not enable every workflow restored from Git history.
