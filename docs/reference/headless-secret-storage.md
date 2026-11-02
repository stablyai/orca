# How the headless server stores credentials

The desktop app seals saved credentials (Linear, Jira, Bitbucket, API keys) with Electron's
`safeStorage`, which uses the OS keychain. The headless server (`orcad`, the managed SSH server)
has no Electron, so it seals them itself, on the machine it runs on
(`src/main/orcad/orcad-secret-store.ts`).

## Where the key lives

Each credential is encrypted with AES-256-GCM. The master key is created on first start and kept
in `~/.orca/orcad-secret-store-<machine>.json`, mode `0600` (an owner-only ACL on Windows), mixed
with the machine ID (`/etc/machine-id`, macOS hardware UUID, Windows `MachineGuid`). That is the
directory the credentials live in, whatever `ORCA_USER_DATA` says, so the key lasts exactly as
long as the credentials it seals. There is one record per machine, so hosts that share a home
each keep their own key.

This is the same on every host: macOS, Linux, Windows and WSL. The server does not use the macOS
Keychain or a Secret Service keyring. A Mac reached only over SSH keeps its login Keychain locked
after a reboot, which made credentials unreadable until someone signed in at the screen. A later
design is expected to keep secrets on the client, as VS Code and Zed do.

A server started with `ORCA_USER_DATA` under a temporary directory (tests, smoke launchers)
keeps the old behavior. It stores credentials unencrypted and never creates a key in the real
`~/.orca`, or re-seals what is there.

Windows does not use DPAPI. Reaching it from Node takes PowerShell or a native addon, and running
PowerShell for each operation is an EDR signal.

On startup the server also deletes key-record staging files (`*.staging`) that a crashed write
left in the credential directory. It deletes only this machine's record's staging files owned by
this user, and only when the process that wrote them has exited.

## Hosts set up by an hourly build that used the keyring

Some hourly builds kept the master key in the macOS login Keychain or the Secret Service keyring,
and wrote a record with `"backend": "os-keyring"` instead of the key. On startup, a server that
finds such a record reads the key once (`security find-generic-password`, or `secret-tool
lookup` when a D-Bus session bus is set), with a 5-second timeout. In a session that may not show
UI, a locked Keychain fails right away (exit 36) instead of prompting.

- If the key reads back and matches the record, the server replaces the record with a key-file
  record holding the same key, not bound to the machine ID. Keyring keys were never machine-bound,
  so every sealed credential still opens and nothing is re-sealed.
- Otherwise (locked, timed out, missing, or a different key), it logs one `[secrets]` line and
  starts a new key file. Credentials sealed under the old key then show the usual "Could not
  decrypt saved Linear credential… reconnect Linear" error, and connecting the integration again
  fixes it. The server does not keep failing closed waiting for the keyring.

Either way the replacement holds a lock file beside the record (`<record>.lock`, so two starts
agree on one key), uses the same atomic write as other key-record changes, happens once,
and leaves the keyring item where it is. This migration is meant to be removed a few releases
after it ships (`src/main/orcad/orcad-legacy-keyring-key.ts`).

## Limitations

- **The key file is weaker than a keychain.** The key sits next to the credentials, and the
  machine ID it is mixed with is not secret. Profile-state records include it, for example. So the
  key file mainly stops a single credential file from opening on another machine. Anyone who can
  read this account's files, or a backup of `~/.orca`, can unseal the credentials. Treat the key
  file like the credentials themselves. The server logs this gap once with the `[secrets]` prefix.
- **The key belongs to the host.** If the record is unreadable or bound to a different machine
  ID, the server does not fall back to plaintext. It leaves the saved credentials
  alone and refuses new saves until the key loads again. If the key is gone for good, deleting the
  record starts over, and every integration has to be connected again. A new machine ID counts as
  a new machine, so it gets a new key, and credentials sealed under the old one have to be
  connected again.
- **Shared home directories.** Integration credentials live in `~/.orca` under the login home.
  Hosts that share that home (over NFS, for example), or a desktop app on the same machine, each
  seal with their own key, so a credential one of them saves can't be read by the others. To keep
  the old shared plaintext behavior on such hosts, set `ORCA_HEADLESS_SECRET_STORE=plaintext`.
- **Rolling back to an older server.** A server from before this change can't read credentials a
  newer one sealed. An SSH or WSL rollback restores profile state, not `~/.orca`, so after a
  rollback the old server shows "Could not decrypt saved Linear credential… reconnect Linear".
  Connect each integration again on that server. Plaintext copies are deliberately not kept for
  rollback.
- **GitHub and GitLab** tokens are not stored by Orca at all. `gh` and `glab` keep them, under
  their own storage settings.

## Migration

On startup, once the key loads, the server seals every credential that an older version stored in
plaintext. Each file is rewritten only after the new value has been decrypted and checked, and
only if no other process changed the file in the meantime. A file that can't be sealed is left as
it was. Readers still accept the legacy plaintext form, so no credential is lost.
