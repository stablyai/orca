# Native Antigravity Accounts

Accounts reads the credential authority on the runtime that owns execution. A client chooses
an owning Orca runtime and a host/distro target before sending an operation; it never replaces
the client's Mac Keychain item for another host. The RPC capability is
`accounts.antigravity-native.v1`. Older paired hosts are refused before account mutations.
The RPC returns account summaries only, never credential JSON, access tokens or refresh tokens.
Displayed quota is tied to the subject and authentication method observed during its refresh;
an external identity change hides the previous account's quota without an automatic fetch.

## Supported authority

Normal macOS agy uses service `gemini`, account `antigravity`. Its go-keyring values use the
base64 or legacy hex wrapper. Orca passes writes through `security -i` stdin, validates bounded
output and reads the entire native value back. The command buffer limit is checked before
writing. A missing native item falls back to the CLI-specific
`~/.gemini/antigravity-cli/antigravity-oauth-token` file. The distinct legacy jetski fallback
is not imported.

The compiled CLI bypasses keyring storage when SSH/WSL environment detectors or WSL kernel
identity apply. A runtime running under that evidenced bypass reads/writes its own CLI file;
it does not contact the client keychain. The file must be private and regular. A macOS
`cache/antigravity-keyring-unavailable` marker makes authority uncertain: Orca refuses instead
of assuming that the keychain or file wins.

Native Windows Credential Manager and native Linux Secret Service remain unsupported.
Windows Orca now routes selected WSL distro operations through the guest file adapter described below.
Windows file bypass is also refused until private ACL protection is verified.
Windows' `gemini:antigravity` raw blob and 2560-byte limit are different from the Mac wrapper;
Linux uses the login collection with `service=gemini`, `username=antigravity`. No dependency,
PowerShell compilation, credential-home flag, or cross-host fallback is invented here.
A separate SSH relay has no Accounts RPC; use a paired owning runtime that implements it.

## Windows-selected WSL accounts

The Windows execution owner advertises `accounts.antigravity-native-wsl.v1`. Clients check
that capability before any WSL operation. Each response contains the concrete distro and an
opaque authority binding; Add, Select and Remove must send that binding back. The host resolves
the actual distro, login UID and canonical login HOME again before acting. A changed default
distro, user or HOME rejects the mutation and asks for a fresh list. Host requests keep their
original shape for older hosts. Remote clients never apply their local account snapshots.

The adapter reads `~/.gemini/antigravity-cli/antigravity-oauth-token` inside the guest, using
`runWslProcess` and `--exec`. HOME must be canonical, owned by the guest user and on a Linux
filesystem; DrvFS and symlink HOME are refused. The token and lock must be regular, single-link,
user-owned files with exactly `0600`; newly created directories use `0700`. Parent directories
must not be group/other writable. Fixed scripts require the ordinary GNU/Linux tools `id`,
`stat`, `base64`, `cmp`, `head`, `mktemp`, `flock`, `mv`, `sync`, `readlink`, `tr`, `date`,
`chmod`, `mkdir`, `rm`, `dirname` and `find`, plus `/proc` descriptor metadata. Unsupported
filesystems or missing tools fail closed. Reads are capped at 64 KiB and verify opened-file
metadata before and after reading. Raw credential JSON travels only over bounded stdin/stdout,
with a nonce and strict UTF-8/base64 decoding; it never goes into argv, environment or errors.

WSL snapshots stay on Windows under `userData/antigravity-accounts/wsl/<scope hash>/vault`.
The hash includes the concrete distro, UID and canonical HOME, and encrypted contents repeat
that scope for verification. Meaningful OS encryption and checked private Windows ACLs are
required before guest mutation. Vault publication is asynchronous, checks cancellation before
rename, and reports failures after publication as requiring verification. Windows 8.3 and long
path spellings are canonicalized when protecting newly created directory chains. Host snapshots
retain their existing format. A reinstall with the same distro name, UID and HOME cannot be
distinguished from the prior installation; snapshots are never automatically restored.

One 15-second budget includes queuing, target probes, ACL protection and guest operations;
clients allow 20 seconds. A guest advisory lock serializes cooperating Orca processes. Writes
use private staging, expected-byte comparison, file sync, rename and readback. Observed conflicts
preserve the current file. A failed WSL mutation blocks further mutations and new managed
launches until Accounts refresh verifies both native credentials and vault; there is no replay
or rollback. Independently running agy does not participate in Orca's lock, so the final check
and rename are not compare-and-swap. Directory sync is attempted in the guest; on Windows the
vault file is synced, but directory fsync is not promised.

Desktop IPC, headless runtime and the local PTY provider verify a selected account before a
new WSL launch, then pin the checked distro into actual spawn arguments and process metadata.
Preparation never writes an old credential snapshot into the guest. An unselected scope keeps
ordinary startup, and a missing WSL vault root skips guest probes. Windows HOME is not guest
HOME. Selected-account launches reject transported authority variables through WSLENV and
unverifiable command wrappers (including user/HOME overrides). Interactive commands, shell
aliases/functions and changes after verification remain outside the guard. WSL quota retrieval
remains disabled; account management does not depend on quota access.

## Identity and snapshots

A Google ID token supplies the normalized Google issuer and stable subject. The authentication
method also scopes identity. The label uses a verified email when available; email is never the
identity key. Account record IDs are random and survive token, expiry, refresh-token and email
rotation. Profiles without a stable subject can be displayed but cannot be saved for switching.

Snapshots preserve the exact native JSON, including fields that Orca does not interpret. The
host's vault under `userData/antigravity-accounts/vault` requires meaningful OS encryption and
private permissions. Weak or unavailable encryption is refused. Unreadable/corrupt ciphertext
is preserved; it is never treated as an empty vault. This does not migrate the experimental
candidate's incompatible array vault or token-hash IDs.

One host service serializes Add, Select, Remove, launch checks and refresh reconciliation.
It re-reads the vault after asynchronous native reads and captures external CLI refreshes into
the same stable account. Selection reconciles the outgoing snapshot, checks the expected native
bytes before writing, and checks native readback before publishing the selected ID. It avoids
writing an old snapshot over an already-active account. The current or selected account cannot
be removed; deletion checks the latest native value again before committing.

A selected account is checked before new Orca PTY launches, including desktop daemon and
headless runtime paths. An externally changed native identity blocks the launch and asks the
user to select again. Existing sessions can retain their original credentials in memory.
Shell commands typed manually into a running terminal are outside the Orca launch guard.

## Sign-in and concurrency limits

Sign-in uses the supported ordinary agy browser/code flow. Users run agy on the owning host;
to add a different account they use its `/logout` command, complete the next sign-in, then save
the actual resulting account in Orca. This implementation does not advertise an Orca-managed
login or invent an agy `login`/`--login` flag. Browser completion and a second real Google
account remain user-driven; tests do not sign out or change the developer's real native item.

Native keyring does not expose compare-and-swap. Orca's queue serializes its own calls, and
bounded before/after checks detect observed conflicts; another independently running agy or
Orca process can still write between the final check and the write or launch. A failed
verification may mean the native item changed but selection was not persisted. Refresh and
explicit selection resolve that state; automatic rollback could destroy a newer CLI refresh
and is deliberately avoided. The file backend has the same external-writer limit.

## Evidence and contributor credit

The foundation adapts the reviewed codec/macOS adapter from #21784 and account-service concepts
from #21797 (nwparker), with fresh identity, persistence, serialization and conflict handling.
The signed-in Accounts card and quota-error visibility acknowledge #19588 by @artile; quota
transport is reused from current main rather than its obsolete extraction code. Targeted
multi-account UI/target concepts acknowledge #23761 by @Tai-DT, replacing its placeholder login
and unused settings selection. The Accounts legacy-Gemini clarification acknowledges #21682
and the original relevant migration contribution by @siddqamar, as requested in #17345.
No stale development stack was cherry-picked.

Live proof uses a disposable Mac service/account item, a fully isolated hidden Electron home,
and synthetic accounts. A private task-only copy was also selected through the real service;
installed agy 1.2.14 consumed that verified file credential under its SSH bypass and returned
`command.name=usage`, `num_turns=0`, no conversation. The real native item remained unchanged.
This proves the Mac adapter mechanics and actual CLI file authority, not a second-account
native-keychain switch, native Windows/Linux switching, or WSL/SSH relay deployment.

## WSL implementation verification (2026-10-06)

Linux/WSL unit and private POSIX script tests cover routing, protocol bounds, permissions,
conflicts, cancellation recovery, encrypted scope separation and stale renderer responses.
Windows Node 24.20.0 on Windows 10.0.26200, WSL 2.7.12 and Ubuntu 24.04 additionally exercised
fresh explicit/default target resolution, nonexistent-distro refusal, synthetic account
save/select/remove/launch reconciliation, token refresh, 0600/0700 modes, expected-byte conflict,
unsafe-mode refusal and native vault ACL readback. This used the production WSL runner and
credential script with a private temporary guest HOME; normal guest credentials were checked
by digest before and after cleanup. The test envelope was synthetic, so this does not prove
the production OS encryption provider or signed-in agy behavior.

Real Windows lifecycle tests require `ORCA_BACKGROUND_LAUNCH=1`,
`ORCA_REAL_ANTIGRAVITY_WSL_ACCOUNTS_TEST=1` and an explicit `ORCA_WSL_TEST_DISTRO`.
They use private temporary HOME/userData, never change profiles or default distro settings,
and compare the normal credential digest. Set `ORCA_WSL_SECOND_TEST_DISTRO` for a distinct
second isolated target. Without those flags the tests skip. Native protected-publication and
ACL tests run only on Windows. Do not enable the older WSL runner's profile-changing real-test
flag against a developer distro.

Release acceptance remains pending for two real distros, real signed-in agy identity,
production OS encryption and hidden-renderer Electron CDP visual proof. Only Ubuntu 24.04 is
available in this session; the required electron skill could not be located, and no application
window was launched. Mocked-platform tests and skipped checks do not count as that evidence.
