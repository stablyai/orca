# Kerberos / GSSAPI SSH Authentication

Orca's ssh2-based SSH stack cannot speak `gssapi-with-mic` — the ssh2 library
has no GSSAPI userauth support, and adding it would mean forking ssh2's
protocol layer plus shipping the `kerberos` native module (MIT krb5 / Heimdal /
Windows SSPI) as a prebuilt Electron dependency on three platforms. Instead,
hosts that need Kerberos ride the existing **system OpenSSH transport** — the
same parallel transport already used for `ProxyCommand`/`ProxyJump` hosts —
which delegates GSSAPI, ticket lookup (`kinit` cache, Windows domain logon),
and credential delegation to the platform's own `ssh` binary on macOS, Linux,
and Windows (Win32-OpenSSH uses SSPI).

## Transport selection

Two tiers, deliberately asymmetric because RHEL-family distros ship
`GSSAPIAuthentication yes` in the global `/etc/ssh/ssh_config`, which makes
`ssh -G` report GSSAPI enabled for *every* host:

1. **Proactive** — a target with `gssapiAuthentication: true` (parsed from an
   explicit `GSSAPIAuthentication yes` in the host's `~/.ssh/config` block, or
   set on the target directly) tries the system-ssh probe first. If that fails
   (e.g. no ticket), the connect falls through to the normal ssh2 key/agent
   path where passphrase/password prompts remain available — OpenSSH semantics
   allow other auth methods alongside GSSAPI.
2. **Auth-failure fallback** — when ssh2 exhausts key/agent auth and the
   `ssh -G`-resolved config enables GSSAPI (`isGssapiSystemSshFallbackCandidate`
   in `ssh-connection-utils.ts`), the connection retries over system ssh
   *before* prompting the user for credentials. Kerberos-only hosts on
   distro-default configs connect this way; hosts where keys work never leave
   the ssh2 path.

Manual (non-ssh-config) targets flagged for GSSAPI get an explicit
`-o GSSAPIAuthentication=yes` in `system-ssh-args.ts`; config-backed targets
inherit the option from their own `Host` block since the system binary re-reads
ssh_config.

Both tiers work headless (`orca serve`): the system-ssh probe needs no
credential callbacks, and GSSAPI itself is non-interactive once a ticket
exists.
