# Release Audit: v1.4.105-rc.3

Date: 2026-06-29

## Summary

The `v1.4.105-rc.3` release run failed after the release-cut steps completed. The tag and draft release were created, but the release was not published because the release-blocking macOS terminal rendering golden job failed.

The failure was an E2E harness issue, not a product runtime issue. On macOS, the seeded test repository was created through `os.tmpdir()` as a `/var/...` path, while Orca canonicalized the added repository path to `/private/var/...`. The shared Playwright fixture then looked for the non-canonical path and threw `Expected e2e repo to be loaded`.

## Outcome

The macOS temp path mismatch was fixed by commit `63e96db7d` (`fix(e2e): canonicalize temp repo paths so golden tests pass on macOS`). The follow-up `v1.4.105-rc.4` release was published successfully.

## Verification

- `ORCA_E2E_FORWARD_APP_LOGS=1 pnpm run test:e2e:terminal-rendering-golden`
- Local result: `2 passed`

## References

- Failed run: `https://github.com/stablyai/orca/actions/runs/28358113523`
- Published follow-up release: `https://github.com/stablyai/orca/releases/tag/v1.4.105-rc.4`
