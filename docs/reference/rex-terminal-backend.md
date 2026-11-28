# Experimental local Rex terminal backend

Orca can optionally create ordinary interactive local shell terminals in an existing Rex server on macOS or Linux. Orca and an independent Rex client can observe the same terminal. The default backend remains unchanged. Saved terminal identities keep their original backend when the preference changes.

## Setup

1. Install Rex and run its server as your own user (tested with Rex 0.1.0-preview.25, control API revision 24).
2. Download the official [libghostty-vt 1.0.2 small WASM and Minisign signature](https://release.files.ghostty.org/libghostty-vt/1.0.2/). See [Ghostty verification instructions](https://lib.ghostty.org/vt/installing.html).
3. With Minisign installed, run from the Orca source checkout:

   ```sh
   node config/scripts/rex/install-ghostty-wasm.mjs /absolute/ghostty-vt-1.0.2-small.wasm /absolute/ghostty-vt-1.0.2-small.wasm.minisig /absolute/orca-user-data
   ```

   The installer checks the pinned public key and SHA-256, uses private permissions, and does not overwrite a different artifact. Neither Rex nor the WASM is bundled or automatically downloaded.

4. In local Settings → Terminal, select Rex as the terminal backend. Open a new ordinary terminal.

The socket must be an owner-only Unix socket at the default Rex location: macOS: `~/Library/Application Support/rex/server.sock`; Linux: `$XDG_RUNTIME_DIR/rex/server.sock` when configured, otherwise `${XDG_STATE_HOME:-$HOME/.local/state}/rex/run/server.sock`. Do not expose it over TCP. The provider resolves parent-directory aliases, then checks that each canonical ancestor is owned by root or the current user and is not writable by other users (trusted sticky directories such as /tmp are allowed). The socket itself must not be a symlink. This check assumes trusted root and same-user processes and ordinary POSIX permissions; it is not peer-credential authentication or a filesystem ACL audit.

To compare the output in an independent Rex client, inspect the new session labeled `orca-rex-…` using the Rex client. Quit and reopen Orca without stopping the Rex server to reattach to the same process. Select Default to create new standard terminals; existing Rex panes are not converted.

## Session capacity and natural exits

Orca reclaims its own managed identity after the original process has exited and the same Rex server confirms the block has ended (or is absent). It detaches without closing the native session or its history. When its 128-record admission limit is reached, Orca attempts a bounded read-only scan for exited, detached identities. Uncertain launches and retirements remain fenced; no live process is terminated to make capacity.

Rex Server has a separate default limit of 64 sessions, including ended sessions and empty sessions. Its native auto-close can remove a block but does not remove the session. Orca does not automatically destroy sessions that another Rex client might use. A definitive session-limit rejection leaves no unresolved launch reservation. To free native capacity, use Rex to remove only sessions you have confirmed are no longer needed, or configure the server's `--max-sessions` limit according to your own retention policy. Closing just the last block is not sufficient. Orca never changes this server setting or destroys a whole session.

## Interrupted launch or retirement

Keep the Orca profile on the local host, not a shared or synchronized filesystem. Launch reservations record the controller PID, a random attempt ID, the original Rex server identity and native session label before dispatch, and a gate-release receipt after the FIFO handoff. These are non-secret identities, not shell commands, environment values or reconnect credentials.

- After a controller exits, a reservation with no dispatch marker and no saved record can be cleared automatically. A new launch still requires a new or explicitly fresh identity.
- If a completed gate handoff and immutable record exist, the next controller can clear the reservation only after exact native server, block, root PID and precise OS process-start identity agree. Reattachment is still attach-only. An exact recorded process confirmed exited can also be reconciled without a release receipt.
- When creation might have happened but no exact immutable record exists, automatic recovery is intentionally refused. Rex API revision 24 does not provide a create idempotency key or an authoritative negative receipt for a lost reply. An error includes the recorded native session label when available. The label is diagnostic, not authority to adopt or delete a block.
- Interrupted retirement is reconciled only when the original controller PID is absent and the same server and recorded process-exit evidence agree. Natural-exit reclamation preserves the native history; explicit close reconciliation requires block absence and the captured process census to certify retirement. A block still present after an uncertain close remains fenced. No close is reissued.
- A PID still present (including reuse), an older reservation without owner/dispatch evidence, a changed server, weak process identity for live restore, or a crash during recovery itself can leave a fence. Never delete journal files to bypass it.

If an error persists after quitting and reopening Orca, inspect the original server using the Rex client's session list and the label in the error. The private profile subdirectories `rex-live-pty/fresh`, `fresh-evidence`, `fresh-recovery`, `retirements`, and `retirement-recovery` hold diagnostic evidence; preserve them when asking for help. Do not copy them into a public issue without reviewing identifiers. An unresolved operation is not a proof that a process has died. The integration does not automate abandonment, native session destruction, or force a retry.

## Boundaries

- This is a local interactive-shell slice, not a complete implementation of remote Rex sharing. Agent and special command launches retain the existing route. Windows, remote Rex attachment, mobile-specific support, headless fresh Rex selection and Hibernate are outside this slice.
- A missing socket, incompatible server, missing/invalid WASM, ambiguous launch/retirement, or changed process identity is an error, not authority to recreate a saved terminal.
- An independent client may control the same Rex block's size. Reattachment does not seize size ownership.
- Native input-mode reset, arbitrary signal requests, and history-retaining/fenced owner shutdown are unsupported. The native server owns live terminal state. A server restart is not guaranteed to preserve Orca's live identity.
- After an ambiguous dispatch, do not delete the identity or intent records to force a retry. Establish whether the original process exists with the owning Rex server. The private records contain identifiers, not launch commands or arbitrary environment values.
- Opt-out affects only new terminals. Before uninstalling this experimental integration, close the Rex terminals you deliberately want to terminate, or keep the Rex server/client available to access them. A code revert does not migrate existing Rex identities.
