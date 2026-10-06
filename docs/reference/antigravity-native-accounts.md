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

Native Windows Credential Manager, native Linux Secret Service, and operations directed from
Windows Orca to a selected WSL distro are explicitly unsupported pending verified adapters.
Windows file bypass is also refused until private ACL protection is verified.
Windows' `gemini:antigravity` raw blob and 2560-byte limit are different from the Mac wrapper;
Linux uses the login collection with `service=gemini`, `username=antigravity`. No dependency,
PowerShell compilation, credential-home flag, or cross-host fallback is invented here.
A separate SSH relay has no Accounts RPC; use a paired owning runtime that implements it.

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
