# 1. A project-group binding forks Claude's config dir

## Context

Managed Claude accounts are globally exclusive on the host runtime. Selecting an account copies its
credentials into the single shared location — `~/.claude/.credentials.json`, the `oauthAccount`
field of `~/.claude.json`, and on macOS both the config-dir-scoped and the unscoped Keychain items —
and the runtime auth service tracks exactly one `lastSyncedAccountId`. `GlobalSettings` records the
intent in a comment: persist only per-account auth, *not* a `CLAUDE_CONFIG_DIR` swap, so switching
accounts does not fork Claude's shared chat and session context. The WSL runtime is the existing
exception, and issue #11824 documents its cost: switching there loses settings, plugins and
statusline.

Per-group account binding requires two identities live at once on one host. That is impossible
while every session reads one shared home.

## Decision

A project group may name a Claude config directory. Agent sessions Orca launches in that group run
with `CLAUDE_CONFIG_DIR` set to it, accepting that the group's chat history, settings and plugins
live in that directory rather than the shared one. Sessions outside a bound group are unchanged and
keep the shared home.

## Alternatives rejected

**Auto-switching the global selection when a bound workspace is activated** keeps one shared home
and forks nothing, but gives no concurrency: a session already running in another group is left on
an identity that silently changed under it, and every switch fights the status-bar chip. The
feature exists to make the account unmissable, and this makes it a race.

**Materializing the bound account into an Orca-owned per-account home** was rejected as the default
in favour of naming an existing directory. It forks context just the same, so it does not avoid this
decision — it only moves who owns the directory, at the cost of abandoning the history and plugins
the user already has in theirs.

Forking is therefore not incidental to the feature; it is the feature's price, and it is paid only
by groups that opt in.
