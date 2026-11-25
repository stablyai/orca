export const SKILL = `---
name: ci-failure-triage
description: Tell a flaky check from a real failure or broken infrastructure, and find the change that started it.
---

# Triaging a failed check

## Sort it first

- **Real failure:** the same test fails the same way on retry, and the failure points at code in the change.
- **Flaky:** it passes on retry with no code change, or fails on unrelated changes too. Look at the last runs of the same check on other branches.
- **Infrastructure:** the runner, network, cache, package registry or a timeout before any test ran. The log ends early or names a service, not your code.

## For a real failure

1. Read the first error, not the last. Later errors are often its echo.
2. Find the commit that started it: the first failing run after a passing one on the same branch.
3. Name the file and line and say why the change broke it.

## For a flaky check

- Keep a list: check name, test name, how many of the last runs failed, the error line.
- Flag a test that fails more than about one run in ten.

## Report

One line per check: name, kind (real, flaky, infrastructure), the cause or the evidence, and the next step. Start a fix only after your owner agrees.
`
