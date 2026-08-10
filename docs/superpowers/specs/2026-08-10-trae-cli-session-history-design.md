# Trae CLI Session History Design

## Goal

Surface sessions written by the Trae internal CLI in Orca's Agent Session History, including workspace filtering, previews, titles, and cold resume on local, WSL, and SSH hosts.

This design targets Trae CLI internal edition `0.200.19+` and its current Codex-compatible rollout contract:

- transcripts: `~/.trae/cli/sessions/**/rollout-*.jsonl`
- title index: `~/.trae/cli/session_index.jsonl`
- resume command: `traecli resume <SESSION_ID>`

## Non-goals

- Supporting the unrelated `trae`, `trae-cli`, or `trae-agent` binaries.
- Supporting older Trae storage formats that do not use rollout JSONL.
- Deleting or archiving Trae sessions from Orca. Removing only a transcript would leave a dangling title-index entry.
- Adding Trae account, usage, or rate-limit management.
- Changing the Agent Session History layout or design tokens.

## Chosen approach

Add a Trae-specific AI Vault adapter over a shared Codex-compatible rollout parser.

Trae remains a distinct agent throughout discovery, parsing, filtering, display, caching, and resume. Only the record-folding implementation is shared with Codex. This avoids leaking `CODEX_HOME`, Codex cache identity, or Codex resume semantics into Trae while keeping the two compatible transcript formats from drifting into duplicated parsers.

Rejected alternatives:

1. Parse Trae as Codex and rewrite the result. This couples Trae to Codex home routing and makes cache, identity, and resume behavior fragile.
2. Copy the Codex parser. This duplicates the most complex part of the integration and creates avoidable maintenance drift.

## Architecture

### Agent registration

Add `trae` to the closed AI Vault agent catalog and label map. The existing TUI agent catalog, process recognition, icon, display name, and launch configuration already support Trae and remain unchanged.

The existing Agent Session History UI consumes the shared agent catalog and session rows. No Trae-specific renderer component is required.

### Source discovery

Add a Trae source with JSONL discovery rooted at:

- local: `<home>/.trae/cli/sessions`
- WSL: `<wsl-home>/.trae/cli/sessions`
- SSH: `<remote-home>/.trae/cli/sessions`

The local scanner receives a `traeSessionsDir` test override so tests never read the user's real home. A custom `TRAE_HOME` storage override is outside this contract until Trae documents that it relocates session storage, rather than only configuration profiles.

Missing roots are an empty history source, not a scan failure. Discovery accepts only `rollout-*.jsonl` files and prunes sibling `*.artifacts` directories. Those directories contain tool outputs and background-task snapshots, not resumable sessions; avoiding their traversal keeps refresh cost proportional to the number of conversations rather than their generated artifacts.

### Parsing

Refactor the existing Codex rollout fold behind an internal descriptor containing at least:

- output agent identity
- session-index title reader
- provider-specific finalization options

Keep public Codex entry points as Codex-specific wrappers. Add equivalent Trae file, content, and incremental-state wrappers that supply `agent: 'trae'`, read the Trae title index, and never set a Codex home.

The shared fold continues to extract:

- session ID from metadata when present, otherwise from the rollout filename
- start cwd and Git branch
- model from turn context or token events
- timestamps
- user and assistant previews
- first and last user prompts through the existing bounded capture path
- total tokens from cumulative or per-turn usage snapshots
- worker-session exclusion signals

Malformed JSON lines are ignored. An unreadable transcript becomes an issue for that candidate without aborting other agents or sessions.

### Title index

Read `<trae-cli-home>/session_index.jsonl` using the same bounded, signature-cached index behavior as Codex, but with a cache key scoped to the Trae index path.

Title priority is:

1. title carried in session metadata
2. title from `session_index.jsonl`
3. first user message
4. `Trae <first-eight-session-id-characters>`

The index is read at finalize time so a title written after the transcript was first cached can replace the prompt fallback on a later refresh.

### Resume

Generate `traecli resume <SESSION_ID>` through the shared shell-aware resume builder. When the session has a cwd, prefix the command with a platform-appropriate directory change.

Trae uses the Codex-style `resume` subcommand but does not use `CODEX_HOME`. The resulting session object must have `codexHome: null`, and resume must not inject or delete Codex environment variables.

Quoting must remain correct for POSIX shells, Windows CMD, and PowerShell. Folder workspaces and Git worktrees use the same cwd-based behavior.

### Incremental cache and first-prompt reads

Register Trae in the incremental parse-cache dispatcher so appended rollout lines reuse the prior fold instead of reparsing the full transcript.

Register Trae in the on-demand first-user-prompt route. This route reparses only the selected transcript with full prompt capture enabled and retains the same path and host validation used by other AI Vault agents.

### Remote compatibility

Add a remote Trae source rather than changing RPC parameters or introducing a stream opcode. The existing `aiVault.listSessions` result schema accepts an agent string before filtering against the receiving build's known-agent catalog:

- an older client safely ignores a `trae` row from a newer host
- a newer client connected to an older host receives no Trae rows
- all other session rows remain usable in both directions

No runtime protocol version bump or capability negotiation is required. Tests must preserve the tolerant unknown-agent behavior.

## Data flow

1. The local or remote scanner discovers Trae rollout JSONL files.
2. Each discovery becomes a candidate with `agent: 'trae'`.
3. The Trae wrapper feeds the candidate into the shared rollout fold.
4. Finalization enriches the row with an indexed title and `traecli resume` command.
5. Existing AI Vault scope filters select workspace, project, or all sessions by cwd.
6. Existing desktop and mobile row renderers display the Trae icon, label, preview, timestamps, and resume action.

## Failure behavior

- Missing sessions or title-index paths: return no rows or use title fallback without an error banner.
- Malformed transcript line: skip the line and continue parsing the file.
- Missing metadata session ID: use the UUID suffix in the rollout filename.
- Missing or malformed title index: retain metadata, prompt, or generated fallback title.
- Unsupported historical format: omit unparseable sessions and report a bounded scan issue when the file itself cannot be read.
- Remote mixed version: omit unknown Trae rows rather than failing the whole response.
- Delete request: remain unavailable for Trae because the transcript and title index are not one atomic delete unit.

## Testing

Follow red-green-refactor for each behavior.

### Parser tests

- Parse a sanitized fixture matching Trae `0.200.19` where `session_meta` has no ID.
- Extract cwd, model, time range, previews, message count, and token totals.
- Fall back to the rollout filename UUID.
- Ignore malformed lines without losing valid surrounding records.
- Reject worker/subagent rollout records using the shared source rules.

### Title tests

- Resolve a Trae thread name from `session_index.jsonl`.
- Observe a title appended after the initial cached parse.
- Fall back safely when the index is absent or malformed.
- Keep Trae and Codex index caches isolated.

### Discovery and scope tests

- Discover a Trae fixture through an injected local root.
- Ignore non-rollout JSONL files and avoid traversing `*.artifacts` directories.
- Include older in-scope Trae sessions despite the global recency cap.
- Resolve WSL roots under `.trae/cli/sessions`.
- Verify workspace, project, and all filters through the existing shared path logic.

### Resume tests

- Produce `traecli resume <id>`.
- Prefix the recorded cwd.
- Quote cwd and session ID for POSIX, CMD, and PowerShell.
- Assert `codexHome` is null and no `CODEX_HOME` prefix appears.

### Incremental and remote tests

- Append records after the first parse and prove the incremental cache updates the row.
- Route SSH candidates through the Trae parser with the remote host identity and platform.
- Pin the remote root and `.jsonl` extension.
- Keep unknown-agent result filtering tolerant for mixed versions.

### Verification

- Run the focused Trae, rollout-parser, resume-command, scanner, parse-cache, and remote-scanner Vitest files.
- Run TypeScript checking and the changed-files quality gate.
- Run a read-only local smoke scan against the installed Trae history and confirm real Trae rows are discovered without printing transcript contents or credentials.

## Acceptance criteria

- Trae sessions appear in the right-side Agent Session History.
- Workspace filtering selects Trae sessions by their recorded cwd.
- Rows show a stable Trae identity, title, time, model, and bounded preview.
- Resume opens the same provider session with `traecli resume <SESSION_ID>` from its original cwd.
- Local, folder-workspace, Git-worktree, WSL, and SSH paths use the same contract.
- Codex home routing, title lookup, incremental caching, and resume commands remain unchanged.
- Older peers continue to process all agent types they already understand.
