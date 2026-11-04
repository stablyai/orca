# Locked audit tools

React Doctor and Knip live in this separate pnpm workspace so application installs
and release bundles do not acquire their dependency trees.

Run the existing root commands (`pnpm doctor`, `pnpm audit:react-doctor`,
`pnpm audit:dead-code`, or `pnpm check:react-doctor:changed`). The runner first installs
this workspace with `--frozen-lockfile --ignore-scripts`, then runs the tool's local
JavaScript entry point from the repository root. Every run checks the manifest
against the lockfile; it never falls back to downloading a CLI through `dlx` or `npx`.

To update a tool, change its exact version in this package's manifest, run
`pnpm --dir config/audit-tools install --ignore-scripts`, and review both the manifest
and generated lockfile. The workspace enforces a three-day release delay and
disables install scripts. Keep its package-manager pin aligned with the root.
Run `node config/scripts/verify-locked-audit-tools.mjs` to exercise both tools.
