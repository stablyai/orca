# Run mailbox ownership and send receipts

A Run ID alone is not a cross-host route. A worker runtime may retain a shadow
record with the same ID as the coordinator's Run, but only the Run home owns its
coordinator mailbox. `orchestration send --to run:<id>` validates that ownership
before inserting a local message.

- A Run recorded with `home_database = remote` rejects an unbound direct send with
  `run_destination_unsupported`. A bound federated worker continues to use its
  existing Dispatch capability and relay by omitting `--to` and `--run`.
- A record without recognized local ownership rejects the send with
  `run_destination_unresolved`. A never-bound local record is not evidence of a
  coordinator mailbox. Both refusals include `data.effectsApplied = false` and
  routing evidence; neither inserts a message or changes consumer authority.
- A locally created Run retains its mailbox through coordinator absence and
  switching to another Run. Its persisted consumer generation proves a past local
  binding; the send does not probe process liveness. Adopted legacy coordinator
  ownership retains its existing compatibility path.

`run-show --id <id> --json` adds a read-only `routing` object: the serving runtime
ID, local/remote/unresolved home, persisted home peer fingerprints for a remote
Run, coordinator handle, and consumer generation. Peer fingerprints come from
authenticated Dispatch attachments, not from a guessed host or a terminal title.
They describe persisted evidence, not current host contact. An empty peer list is
unknown ownership evidence, not proof that a remote coordinator exited. Database
paths and pane keys remain private.

Local Run send receipts include `delivery.state = queued` and
`delivery.custody = run_home_mailbox`. Remote worker receipts include
`relay.state = queued`, `relay.custody = worker_relay`, `homeRunId`, and
`homePeerFingerprint`. These are enqueue snapshots, not proof of coordinator
consumption, acknowledgment, or task acceptance. A disconnected home leaves the
existing relay custody intact. Task settlement and coordinator delivery retain
their separate existing receipts.

## Compatibility, recovery, and rollback

The receipt and inspection fields are additive. Older clients ignore them; a
client talking to an older runtime must treat absent fields as unknown, not as
delivered. Older coordinators that omit their Run ID still use the existing
per-Dispatch compatibility stub and relay route; receipts report `homeRunId: null`
instead of presenting that local stub as the actual home Run ID. Explicit `--to`/`--run` on bound
federated workers remains unsupported by the existing target guard; this change
does not introduce a generic cross-host Run-address relay.

There is no schema migration or automatic recovery. Existing orphaned mail stays
available to read-only inbox inspection. Rebinding or taking over the shadow Run
is not a routing repair: it changes consumer authority and does not transfer mail
to the actual home. Inspect both runtimes and preserve the original message IDs
before coordinating any explicit recovery. Never infer process death from lost
host contact.

Reverting the change leaves the database readable and removes the new rejection
and receipt fields, but also restores the unsafe shadow-mailbox acceptance.
Updating only the coordinator does not protect sends handled by an old worker
runtime; update the runtime accepting those sends. Native macOS/Linux/Windows,
SSH control-plane routing, and folder workspaces share this database/RPC path;
there is no filesystem or Git-specific destination inference.

The isolated two-runtime regression suite is
`src/main/runtime/rpc/methods/orchestration/messaging/send-run-home-federation.test.ts`.
It uses independent in-memory databases and the real RPC dispatcher and federation
relay over a scripted transport, without operating any desktop runtime or terminal.
