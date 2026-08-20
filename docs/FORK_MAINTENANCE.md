# Fork maintenance

This fork keeps two long-lived branches:

- `upstream-main` is a read-only mirror of `stablyai/orca:main`.
- `main` is the personal distribution and may contain fork-only changes.

Never commit to `upstream-main`, merge `main` into it, or use it as a development
branch. The scheduled `Sync Upstream Main` workflow updates it every hour at
minute 17 and can also be run manually.

## Remotes

Use `origin` for `rudironsoni/orca` and `upstream` for `stablyai/orca`:

```bash
git remote -v
git remote add upstream git@github.com:stablyai/orca.git
git fetch origin
git fetch upstream
```

Add `upstream` only if it does not already exist.

## Update the upstream mirror manually

```bash
git fetch upstream
git push origin upstream/main:refs/heads/upstream-main
```

This push must remain fast-forward only. Do not add `--force`. If it fails,
inspect the branch history instead of rewriting the mirror.

## Update personal main

```bash
git fetch origin
git switch main
git merge origin/upstream-main
git push origin main
```

Merge upstream updates into published `main`. Do not continuously rebase or
force-push this long-lived branch.

## Start fork-specific work

```bash
git switch main
git pull --ff-only origin main
git switch -c personal/<descriptive-name>
```

The `personal/` prefix identifies fork-only work but is not enforced.

## Start an upstream contribution

Read the current upstream contribution guide before starting. Base contribution
branches on current upstream history, never on customized `main`:

```bash
git fetch upstream
git switch -c fix/<descriptive-name> upstream/main
```

Use `feat/<descriptive-name>` or another descriptive prefix when appropriate.
Open the pull request with `stablyai/orca:main` as the base and the fork branch
as the head.

## Refresh an upstream contribution

Temporary contribution branches may be rebased:

```bash
git fetch upstream
git rebase upstream/main
git push --force-with-lease
```

Rebasing keeps a temporary contribution focused on current upstream history.
Merging is preferred for personal `main` because it preserves the published
history other work may already depend on.

When a contribution is also wanted in the personal distribution, prefer to let
it return through upstream after acceptance and the normal mirror-to-main flow.
Upstream may squash or rewrite the pull request commits. Cherry-pick it into
`main` only when immediate inclusion is a deliberate choice.
