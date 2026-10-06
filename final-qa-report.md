# PR 25658 final QA evidence

- Final exercised head: `37f4353d0905d621c104f33fafdb9889a263b1fa`; corrected final CDP driver completed 29 records, including the six catalog-resolved locale screenshots. Root instructed that this actual 37f capture is reused for `c261` because the only change is unused English-key removal; this worker did not run a new app capture at c261.
- Detached `origin/main` baseline was fetched once and pinned at `ccc0bf70e46ea33b1f9d735942de9d2a71664cd2`. Its actual Appearance page has no Chat section, chat inputs, or preview at either full viewport; 14/12 and 20/18 are therefore unsupported and are not comparison geometry or inherited proof.
- The corrected 37f app and the main baseline app were each launched under isolated `env -i` HOME, ORCA_DEV_USER_DATA_PATH, CODEX_HOME, and CLAUDE_CONFIG_DIR, with background launch and mock keychain/password-store flags. Both owned app trees and isolated daemons were stopped through their verified wrapper groups; listener/PID/group post-stop receipts and daemon SIGTERM logs are attached.

## Scope and remaining limit

- Native context-menu/clipboard behavior was not run, by design. Main cannot establish whether final preview layout behavior is inherited because it contains no equivalent surface.
- The previous parent baseline and early locale artifacts remain historical/incomplete and are not promoted by this report.

## Sensitive-path observation

- `~/.codex/hooks.json` and `~/.codex/config.toml` SHA256 values were compared before/after and remained unchanged in the recorded checks. A trust-count `grep -c` was actually performed during this fresh dispatch under an earlier coordinator rule; after the rule changed it was removed from active claims and was not read again. No Claude or Grok path was read.
