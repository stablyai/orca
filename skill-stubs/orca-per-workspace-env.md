# Per-Workspace Environments

This file is a discovery stub, not the usage guide. The full, version-matched per-workspace
environment reference is served by the `orca` binary itself — kept out of this file on
purpose so it can never drift from the binary that will actually run your commands.

<!-- shared: resolver -->

## Load the full guide before running Orca commands

```text
ORCA skills get orca-per-workspace-env
```

That prints the complete, version-matched guide for the exact binary that will handle your
next commands — provider setup, base and auth snapshots, `environmentRecipes` in
`orca.yaml`, lifecycle scripts, and `orca vm recipe doctor`. Read it first, then run the
specific command you need.

<!-- shared: no-guessing -->

<!-- shared: older-binary-intro -->

```text
ORCA status --json
ORCA vm recipe doctor <recipe-id> --repo-path <repo> --json
```

The doctor command above is the free static check. Never add `--provision` without the
user's explicit approval: it creates provider resources and spends the user's cloud money.

<!-- shared: older-binary-outro -->
