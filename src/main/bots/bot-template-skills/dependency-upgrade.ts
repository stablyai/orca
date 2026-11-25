export const SKILL = `---
name: dependency-upgrade
description: Upgrade dependencies one group at a time, reading changelogs and running tests, one pull request each.
---

# Upgrading dependencies

## Find what to upgrade

- Security advisories first, by severity.
- Then major versions, then minor and patch updates.
- Use the project's own package manager and its audit command; don't switch tools.

## Group them

- Packages released together (a framework and its plugins) go in one group.
- Each major version upgrade is its own group.
- Minor and patch updates with no advisories can share one group.

## For each group

1. Read the changelog or release notes between the current and the new version. Note breaking changes and anything deprecated that the code uses.
2. Upgrade only that group. Keep the lockfile change in the same commit.
3. Run the build and the tests. Fix what the upgrade broke, or stop and report it.
4. Open one pull request per group. Its description lists the versions, the breaking changes that applied, and what you changed because of them.

## Report

Most urgent first: package, current and new version, why (advisory or major), and the effort you expect. Open pull requests only after your owner agrees.
`
