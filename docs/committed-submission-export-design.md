# Committed submission export

## Decision

Use an isolated committing host for one enrolled bot. Give its journal and attachment store an OS principal that never executes a provider, plugin, terminal or agent command. Keep the ordinary provider host and all other chats in their existing account. The protected writer derives bot ownership from enrollment and the committed chat record. A subscriber accepts only authenticated local deliveries from this writer.

The alternative is to keep the ordinary desktop journal and add a separately hardened producer release, an independently enrolled signing identity, and commit-time signatures. It avoids journal migration but requires separate release and key custody, plus protected recovery evidence when the desktop crashes before it can publish. The isolated host keeps the durable source and recovery authority together.

## Commit and delivery

Enlist the export row in the native chat admission transaction. A rollback produces no visible event. Use a host-generated event ID and monotonically increasing export sequence, a versioned encoding, host source kind, original content, attachment lengths and digests, and an explicit predecessor where supplied. Never infer a correction from message text. Only capture complete input. Reject unsupported or inaccessible attachments before committing an enrolled submission.

After commit, deliver bounded batches over local IPC. The subscriber checks the enrolled identity, schema, byte limits, predecessor, attachment digests, and cursor before appending evidence. It acknowledges only after durable append. Retry an identical event idempotently; reject reuse with different bytes, sequence gaps, and unknown versions. A subscriber outage leaves committed rows available for replay. Keep key rotation and revocation outside the event payload.

## Cutover and rollback

Determine the bot's workspace from the host's trusted bot registry. Enumerate only its sessions and attachment references. Refuse ambiguous ownership and unfamiliar schema. Quiesce that bot, take a protected snapshot, and compare the copied session and event counts and original byte hashes with the source. Retain an independently protected manifest. Treat imported history explicitly as migration evidence.

Require a single writer epoch and an explicit cutover decision. Quarantine the selected legacy rows read-only; other sessions keep their existing writer. Readers that cannot honor the epoch must refuse the migrated bot. A rollback after new admissions requires draining deliveries, reconciling both streams, and recording a new writer epoch. Replacing a newer database with the old snapshot would lose accepted submissions.

## Acceptance

Verify direct invocation by an agent cannot create a trusted event; a replayed event cannot create a second record; changed bytes, traversal, wrong identity and revoked keys fail closed. Interrupt both sides at each persistence boundary. Confirm the original bytes, durable receiver ID, revision, digest and repeat receipt after restart. Treat a successful transport response as a delivery acknowledgement only.
