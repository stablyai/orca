# Accounts and session continuations

A workspace account is the default for new launches on the host and runtime that own it. An existing conversation keeps its acquired account. History can open an independent continuation with a different account without changing the workspace binding.

## Ownership and account choice

The host verifies the transcript against its current History scan roots and checks the provider session identity. When roots share physical storage, the requested logical home identifies the source; ambiguous ownership is refused. An imported transcript can retain the original session ID, so the ledger identifies a transcript by provider and normalized path, within its recording host.

History first offers the account recorded at the last successful open. It asks the user to choose when that account is unknown, unavailable, or differs from the workspace default. The storage account and last-used account are separate facts. A System default route does not establish a historical email address.

The host validates the choice again before launch. The resulting receipt pins the selected home ahead of workspace and host defaults. A missing account or a changed home produces an error instead of falling back to another login. Launch pins are persisted separately from last-used metadata so cold restores can retain a verified choice after a receipt is committed.

## Independent transcripts

Continuing under another account creates a transcript with a new provider session ID in that account's home. Authentication and source transcripts are not copied back or changed. Claude attachments and file-history entries needed by the continuation are copied with it. Codex continuations are indexed before launch.

The copies share lineage metadata, not a writable conversation. New messages belong only to the selected copy. Orca does not merge concurrent conversations or combine account quota. History groups related copies, but uses a version's own scanned metadata when presenting it.

An unopened prepared copy is recorded before Codex indexing. A retry repairs that same copy. Concurrent preparation of the same source and destination is coalesced. Failed preparation does not publish a usable launch receipt.

## Opening and recording

Preparation does not establish the account last used. The renderer waits for a terminal binding, including a paired host's mirrored terminal, or for native-chat creation to settle before committing the receipt. A failed History write offers a commit-only retry rather than launching another terminal or chat.

The ledger upserts by transcript identity, making partial-write retries safe. Receipts expire for commit purposes; retained launch pins still require the account to be available and its prepared home to match. No credentials are stored in lineage or receipt metadata.

## Private Claude history

Workspace-bound and history-imported Claude accounts require private-history setup before launch, even when an older profile setup marker exists. Setup failure blocks the agent while an ordinary terminal remains usable. Orca detaches its own shared directory links and Windows prompt-history hard links, including retired links identified by their ownership record. Unrecognized external links require user intervention. Existing private files are preserved.

Account removal blocks new setup work, drains the account's pending setup, then removes its folder. A timed-out setup worker must exit before its failure is returned.

## Runtime scope

Accounts and transcripts stay on the recording host. Folder workspaces use the same account policy as Git worktrees. Native host and WSL account lanes remain separate. The cross-account chooser and history import currently support native host transcripts; WSL Codex credential enrollment remains available through the CLI. Direct SSH targets without an account RPC owner cannot offer workspace account selection.
