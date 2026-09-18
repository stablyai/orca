# Cursor usage in the status bar

Orca reads monthly subscription usage from the Cursor account signed in through
`cursor-agent` on the computer running the Orca runtime. The existing Usage
popover controls detailed and compact presentation, and the existing preference
selects used or remaining percentages. Appearance settings can hide the item.

The detailed footer labels Cursor Models and Other models separately. Compact
mode shows the most consumed reported pool. If only the total percentage is
available, the footer shows the monthly window. Zero is displayed only when
Cursor explicitly reports it; missing percentages are not inferred from spend,
bonus credits, plan prices, or the other pool.

## Authentication and scope

The main process reads the CLI's `auth.json` asynchronously:

| Host                | Location                                                                        |
| ------------------- | ------------------------------------------------------------------------------- |
| Windows             | `%APPDATA%/Cursor/auth.json`, with the home AppData fallback                    |
| Linux               | `$XDG_CONFIG_HOME/cursor/auth.json`, defaulting to `~/.config/cursor/auth.json` |
| macOS file fallback | `~/.cursor/auth.json`                                                           |

This integration does not import accounts, refresh tokens, alter CLI files, or
read the editor's SQLite database, browser cookies, or OS Keychain. A CLI that
stores credentials exclusively in an OS credential store is not supported by
this file reader. Windows file authentication and the endpoint were verified
live; macOS and Linux path handling have unit coverage, not live account proof.

This is an account meter, not per-workspace accounting. Folders and git worktrees
share it. A paired client receives the serving runtime's snapshot; selecting an
SSH or WSL workspace does not change the account to that workspace's credentials.
No client credential is forwarded to a different execution host. WSL-specific
accounts and the Accounts settings pane remain outside this integration.

## Data and failure handling

The request uses the existing Cursor dashboard Connect endpoint:
`POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`.
This is an undocumented personal-account endpoint, so its schema or authentication
may change independently of Orca. Requests have a timeout, use cancellation, and
reject redirects. Transport errors are sanitized before reaching the renderer.

The fetcher maps explicit `planUsage.totalPercentUsed`, `autoPercentUsed`, and
`apiPercentUsed`, using the billing cycle's real end for renewal. The existing
rate-limit service owns polling and stale-data presentation. A private credential
fingerprint invalidates old snapshots and cooldowns after a login change. The
credentials are checked again before applying a result to discard late responses
after logout. HTTP 429 respects `Retry-After`, including on manual refresh.

Cursor snapshot fields are optional on the wire. The
`status-bar.cursor-item.v1` capability prevents new clients from sending the
Cursor status-bar enum to older hosts, which would otherwise reject the entire
UI preference update.

## Prior work

The footer integration builds on [PR #16815](https://github.com/stablyai/orca/pull/16815),
with account identity, request boundaries, cooldown, compact display, and current
schema corrections. Remote capability handling adapts
[PR #18119](https://github.com/stablyai/orca/pull/18119). It addresses the footer
portion of [issue #15516](https://github.com/stablyai/orca/issues/15516), which also
requests account management and WSL behavior beyond this scope.
