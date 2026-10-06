# PR 25658 final QA evidence (corrected)

- Final exercised head: `37f4353d0905d621c104f33fafdb9889a263b1fa`; corrected final CDP driver completed 29 records, including six catalog-resolved locale screenshots. Root instructed reuse of this 37f capture for `c261` because that change only removes an unused English key; this worker did not recapture c261.
- Detached `origin/main` was fetched once and pinned at `ccc0bf70e46ea33b1f9d735942de9d2a71664cd2`. Its Appearance page has no Chat section, chat inputs, or preview at either captured viewport, so 14/12 and 20/18 are unsupported—not equivalent or inherited geometry.
- Both isolated app trees and daemons were stopped via verified wrapper groups. PID/group/listener checks passed and daemon logs show SIGTERM shutdown; the main daemon socket pathname remains as a stale file after shutdown, so endpoint-file absence is not claimed.

## Limits

- Native context-menu/clipboard behavior was deliberately not tested. Earlier parent-baseline and early-locale files remain incomplete and are not promoted.

## Profile safety observation

- `~/.codex/hooks.json` SHA256 was `78922a784ee78e9e50587e93628cd3b9d4dfbe49087adc4514e6781cea38cbb9` at initial and final recorded checks (unchanged).
- `~/.codex/config.toml` SHA256 changed from recorded initial `375d81e0cf0617ba4f5e2602fb5e6de646c84b8626d4e95e325f27181d01a2b8` to recorded final `b4aa2f152347bca26ebb40af765786530f757aba234f0cfd97d945aae9d32e48`; this is an observation only, without attribution, content inspection, restoration, or a QA stop.
- A real trust-count grep occurred during this dispatch beyond the final hash-only rule. It was not repeated after the rule was clarified; no Claude or Grok path was read.
