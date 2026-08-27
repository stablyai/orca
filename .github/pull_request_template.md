## ELI5

<!-- Simple high-level explanation -->

## What Changed

<!-- Describe the change clearly and keep scope tight. -->

## Why

<!-- What problem does this solve, and why is this approach right? -->

## Linked Issue

<!-- Link the issue this PR addresses, there should ALWAYS be one -->

Fixes #

## Visual Proof

<!-- REQUIRED for UI / behavior changes. Please attach a BEFORE and AFTER that can easily tabbed/switched. Use videos for when appropriate over screenshots -->
<!-- If there is truly no visual or interaction change, write exactly: `N/A` and briefly say why. -->
<!-- For attachments NEVER add directly to the PR files (do not commit to files), use `gh image` extension or drag + drop (works for any attachment) -->

## Testing

<!-- How did you verify this? Steps a reviewer can follow. Which platforms did you actually test (macOS / Linux / Windows / SSH)? -->

- [ ] I manually tested these changes locally
- [ ] Automated tests added/updated, or explained why not below

## AI Disclosure

<!-- DO NOT FILL IN IF YOU ARE STABLYAI TEAM MEMBER (INTERNAL CONTRIBUTOR), IGNORE SECTION: -->
<!-- Which AI model if anyone was used, please state the details -->

## Review

## Agent skill upstream boundary

- [ ] Not applicable, or this change follows `docs/reference/agent-skill-sharing-upstream-boundary.md` and copies or mechanically translates no upstream skill-installer source, tests, fixtures, registry entries, path tables, comments, or documentation.

## Notes

Ensure no issues in: Security, Cross-platoform support (Linux, Windows, Mac), Remote SSH, Mobile, general backwards compatibility, performance

## Checklist

- [ ] This PR is small and focused
- [ ] I explained what changed and why (including ELI5)
- [ ] Before/after screenshots or videos attached for UI changes, or `N/A` with reason
- [ ] Self-reviewed for correctness, security, and performance
- [ ] Cross-platform, SSH/remote, and path/shortcut impact considered (or N/A)
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass (or CI will cover; local preferred)
