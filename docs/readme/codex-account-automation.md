# Codex account automation

Settings → Accounts has independent, default-off controls for automatic account switching and reset warming. Automatic switching also has a default-off **Continue automatically after switching** option. Warming never changes the selected account or a conversation's model/effort.

## Account switching

A native Codex `turn/completed` notification with the typed `usageLimitExceeded` error starts selection. Authentication, transport, and general rate-limit errors do not. Selection reads fresh quota for registered accounts in the outgoing account's host/WSL lane. Missing windows, failed reads, expired exhausted snapshots, and stale observations are not capacity. Manual selection/removal invalidates an in-flight automatic transaction. A bounded set of previously attempted homes prevents an automatic continuation from cycling between accounts.

Only a settled primary turn without pending dispatch echoes, tools, approvals, or background tasks is eligible. The host verifies the existing transcript's provider thread ID, retains that same file through a hard link, proves the exact old provider process has exited, and repins the durable session account. Existing lease settlement and conversation recovery reopen the same provider thread. Conversation settings and accepted journal entries remain intact. Selection and migration share the existing account mutation queue.

With automatic continuation off, recovery pauses for the user. With it on, recovery sends one new continuation through the existing durable operation ledger. It never resends the original prompt or dispatches a previously completed tool operation. An ambiguous continuation is not retried automatically. A model can still choose to perform another action in response to the new continuation; these tests cannot prove model behavior. A crash before the continuation is admitted leaves the conversation paused.

### Supported recovery boundary

This change supports transcript-backed native Codex conversations where the source and destination can share the verified transcript through a hard link. It refuses different transcript writers, database-backed (`paginated`) history, or unproven process exit. Newer Codex versions commonly use database-backed history, so this is a material limitation, not a claim of universal seamless failover.

Terminal sessions retain their existing **Restart with account** workflow; no terminal scraping or blanket pane termination was added. Native WSL session launch remains subject to the adapter's existing support boundary. SSH execution stays on its owning host; the local account pane does not configure a remote host's automation. Folder workspaces use the same durable session machinery as git worktrees.

## Reset warming

The main process loads `codex-reset-warming.json` from the profile directory on startup and checks every 30 seconds while Orca is running. Saved overdue deadlines are processed after restart or sleep. There is no external daemon or activity while the app is closed. Quit drains cancelled background work through the existing teardown barrier.

Each registered account is tracked independently, including inactive accounts. The scheduler preserves the earliest unattempted server deadline when an unused window's estimate slides forward, coalesces simultaneous session/weekly resets, and defers if either known window is still exhausted. Null windows are unknown. Observed foreground usage can establish a new window without another inference.

Before submission, an attempt for each due epoch is durably written using Orca's existing durable-file writer. A crash or ambiguous response consumes that attempt; it is not replayed. A new future deadline is accepted only with positive observed usage, preventing repeated warmups from sliding unused-window estimates. Account removal, disablement, and lifecycle cancellation invalidate stale callbacks. Unreadable durable state fails closed.

Model discovery uses the actual account's advertised model/effort catalog. Selection intersects exact model IDs with Orca's maintained usage-pricing metadata and requires a price no higher on input, cached input, or output than any other priced eligible choice. Effort is the lowest advertised value, preferring `none`, then `minimal`. Unknown pricing/efforts or incomparable prices do not trigger an inference. There is no retry with a more expensive/default model. Pricing metadata must remain current; it estimates relative cost and does not promise a provider billing amount.

The isolated ephemeral request asks for exactly `OK`, uses an empty working directory, disables user rules/config, project docs, web search, MCP and integration/tool features through CLI configuration, and never invokes credit/reset mutations. Unsupported isolation flags fail before successful inference rather than falling back. Discovery is reaped before inference. Exact reply plus successful completion is checked separately from nonfatal diagnostic items, then fresh quota is read. Only observed post-reset positive usage records activation as verified; completion alone is unconfirmed.

Native sessions reserve their home before acquisition and drain background work. Existing attributed terminal panes defer warming, and a newly recorded pane cancels an in-flight warmup on the next foreground check (250 ms). There is a small terminal spawn/attribution race: a request already accepted by the provider cannot be unspent. External Codex processes not owned or attributed by Orca cannot be detected reliably. No unrelated process is stopped.

## Validation and remaining evidence

Automated tests use injected quota/catalog results, fake protocol transports, and real temporary transcript hard links/session records. They exercise typed exhaustion, unknown/auth/network quota, account/runtime eligibility, manual selection races, stale transaction observations, durable attempt ordering, crash/restart deduplication, simultaneous/sliding resets, deletion/disablement, isolated model selection, safe migration, and one-shot continuation admission.

No paid provider inference was performed for this implementation. Automated tests establish orchestration behavior, not live provider migration or billing/window activation. Live compatibility for supported transcript history, Windows/WSL/SSH execution, and rendered Electron settings remains a pre-release validation requirement. The required `$electron` validation skill was unavailable in this environment; no visible app or installed app was launched/replaced.

Protocol reference: [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server), checked alongside locally generated protocol types. The base checkout is `ddbad2218be016f3ce9e833fe65170976e55e0dc` (source package 1.4.197); the installed app reported 1.4.202 and was left untouched.
