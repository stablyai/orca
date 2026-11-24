# Dependency security checks

`pnpm check:dependencies` audits the desktop, mobile, cloud, docs, and isolated
audit-tool lockfiles, including development and optional dependencies. It does not
install those workspaces or execute their pnpm hooks. High/critical advisories and
scanner failures fail the check; lower severities remain visible in JSON reports
under `tmp/dependency-security/`.

The Linux workflow runs on dependency-change PRs, manually, and when cutting a
stable desktop release. There is no daily schedule. The release check scans the
exact release tag in parallel with builds; RC releases skip it. Audit findings are
advisory in CI, and release publishing proceeds independently of the scans.
Findings that fail the audit command, or scans that cannot complete, send a review
notice with the Actions reports link to `orca-releases` through the existing
`SLACK_WEBHOOK_URL`. Fork PRs without access to that secret retain their reports
in Actions. Notification delivery is also advisory. Stable releases audit the
desktop and embedded mobile-web lockfiles plus native Rust. Cloud, docs, and isolated audit tooling
remain covered by dependency PR checks and do not block desktop releases.
Scanner tooling and exception policy come from the workflow commit, while
lockfiles, patch registrations, and patch bytes come from the release tag. Only candidate Rust manifests, lockfiles, and patches are extracted; candidate
package manifests, pnpm/Cargo configuration, and toolchain overrides are excluded. The candidate is
not installed and its pnpm hooks do not run. Branch protection is unchanged.

The Rust job runs pinned cargo-deny 0.20.2 directly against every native manifest
with `--locked`, all features, and no target restriction. The scanner binary is
cached; advisory data is fetched on every run. Reports upload even on failure.
The first CI run took 44 seconds for JavaScript and 2m04s for Rust, including a
cold scanner installation; the audit steps themselves took 2 and 1 seconds.

The only JavaScript exceptions cover previously reviewed local patches. Each
names an exact workspace, package, version, advisory, owner, expiry, patch path,
and SHA-256. An exception is considered only for an actual high/critical finding.
The patch bytes, workspace registration, and locked patch hash/snapshots must
match before the exception applies. Expired exceptions stop exempting findings;
stale exceptions for removed/fixed packages do not fail clean scans. Remove an
exception and its patch when an upstream fixed version replaces them.

This initial check covers JavaScript and native Rust advisories. It does not
establish reachability or scan licenses, container layers, downloaded binaries,
CocoaPods, Gradle, or Ruby dependencies. Registry/advisory outages remain visible
in reports and Slack notices. After installing
cargo-deny, the Rust command can also be run locally:

```sh
cargo deny --manifest-path native/windows-agent-hook/Cargo.toml --locked --config config/cargo-deny.toml check advisories
```
