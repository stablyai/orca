# SSH host key verification (STA-4319)

Revised after security and migration review. Where a first draft was wrong, the correction is kept
visible rather than quietly edited out — the reasoning matters for anyone changing this later.

## The defect

`src/main/ssh/ssh-connection.ts:1184` installs a `hostVerifier` that records a SHA-256 fingerprint
and then `return true`. Every ssh2 connection accepts every host key. There is no `known_hosts`
consult, no trust record, and no change detection anywhere in `src/main/ssh/`. There is exactly one
ssh2 `Client` construction site, so the fix has a single chokepoint.

Scope is per-connection, not per-feature: one `SshConnection` per target serves exec, SFTP, port
forwarding, the filesystem watcher and relay deploy.

### Threat model, corrected

Traffic is still encrypted, so a passive observer gets nothing. The exposure is an **active**
attacker who can redirect the connection — ARP/DNS spoofing, hostile Wi-Fi, a hijacked internal name.

Three corrections to the first draft:

- **Jump hosts are NOT the worst case; they are already safe.** `shouldUseSystemSshTransport`
  (`ssh-transport-selection.ts:71-91`) returns true for exactly the conditions under which
  `resolveEffectiveProxy` (`ssh-proxy-command.ts:17-38`) returns a proxy — the two branch on the same
  inputs in the same order — and `attemptConnect` returns unconditionally after the system probe
  (`ssh-connection.ts:670-673`). So ProxyJump/ProxyCommand go through OpenSSH and are already
  verified. The ssh2 proxy-spawn at `:697` is effectively unreachable. Good news for migration, and
  the first draft's motivating example was simply wrong.
- **Agent forwarding was overstated.** `agentForward` is gated on the user's `ForwardAgent yes`
  (`ssh-connection-utils.ts:203-205`). `config.agent` is always set, but that is agent _auth_, whose
  signatures bind the session id and cannot be replayed onward. The risk applies to users who opted
  into `ForwardAgent`, not everyone.
- **Credential theft was understated, and the relay claim was backwards.** `isAgentFallbackError`
  treats _any_ auth error as agent fallback (`ssh-connection-utils.ts:59-61`), so a MITM that rejects
  publickey walks the user to the password prompt (`ssh-connection.ts:844`) and the private-key
  **passphrase** prompt (`:834`), and `cachedPassword` is replayed without prompting on every
  reconnect (`:709`). Meanwhile the relay upload matters less than assumed — the attacker already
  owns their machine. The real client-side impact is the **return** direction: the attacker becomes
  the host our workspace trusts, driving relay protocol frames, landing SFTP content in local
  worktrees, and feeding agent-hook payloads in.

## Decisions

### D1. Read the user's `known_hosts`; write only to our own store

Consult the user's real `known_hosts` as a trust source — most developers already have their hosts
there from `ssh` and `git`, which is the entire migration story. Do **not** write to it: that file is
shared with every other SSH tool on the machine, and appending brings line-endings, permissions,
concurrent writers, and a corruption blast radius well beyond us.

Two consequences to own rather than discover:

- **Revocation does not propagate into our store.** `ssh-keygen -R host` clears `known_hosts` but not
  our record. That is survivable for the ordinary rotation, because a `known_hosts` MATCH is now
  decided before our store's mismatch — running the remedy we print and reconnecting works, which it
  did not when the store was consulted first. What it does not cure is a host we only ever knew
  ourselves, never written to `known_hosts`: there is no `ssh-keygen -R` for that one, so the
  rejection names the store file directly. The "forget" action (D5) replaces that with a button; its
  helper is deliberately absent until then, since an exported API nothing can reach is unverified in
  production. Mismatch messaging must keep naming which source disagreed.
- **`ssh -G` on the HOME-divergent `-F` path suppresses `/etc/ssh/ssh_config`**
  (`ssh-g-config-resolution.ts:44-52`), hiding site-wide `StrictHostKeyChecking yes` and
  `GlobalKnownHostsFile`. On that path we must fail **strict**, never laxer than `ssh` would.

  There is no `ssh`-only way out of this: `-F /dev/null` does NOT invert the exclusion, it reports
  built-in defaults, so a probe built on it looks permissive on every machine. Verified against
  OpenSSH 10.2p1. So the file is read directly, answering a deliberately weaker question — _could_
  the site config be restricting host keys — where anything ambiguous (unreadable, an unresolvable
  `Include`, the directive present at all) keeps the refusal. Only a site config that demonstrably
  says nothing about host keys clears it, which is what stops the rule punishing every devcontainer,
  `su` shell and Nix shell.

### D2. Ask `ssh -G`, do not reimplement config resolution

`ssh -G` reports `userknownhostsfile`, `globalknownhostsfile`, `stricthostkeychecking`,
`checkhostip`, `hostkeyalgorithms`, `fingerprinthash`, `hashknownhosts`, `updatehostkeys` and
**`hostkeyalias`** — with `Match` and `Include` already applied. `resolveWithSshG` exists and simply
does not read them yet.

`userknownhostsfile` is a space-separated list on one line, may contain `~`, and may contain
double-quoted paths with spaces. When `ssh -G` is unavailable (no `ssh`, non-zero exit, >5s timeout)
fall back to `~/.ssh/known_hosts` + `known_hosts2` — never to accept.

`HostKeyAlias` must be honoured: users tunnelling bastions through `localhost:port` depend on it and
would otherwise hit spurious mismatches. It appears nowhere in `src/main/ssh/` today.

**Lookup key.** Config resolution uses `configHost || label` (`ssh-connection.ts:660`) while ssh2
dials `effectiveHost` (`ssh-connection-utils.ts:188`). The `known_hosts` lookup must use
`HostKeyAlias` if set, else the **resolved hostname** — keying on the Orca label would miss every
existing entry.

**Two ordered lookup passes, not one candidate set.** Verified against OpenSSH 10.2p1: a non-default
port looks up `[host]:port` first, and if that finds nothing it retries the **bare** host. Crucially,
on that second pass a wrong key is downgraded to `unknown` rather than reported as changed. So the
passes are `[['[host]:port'], ['host']]`, and the fallback pass can only yield `match` or `unknown`.
Collapsing them into one set would give a spurious first-contact prompt to anyone who has a bare
line and connects on a non-default port; treating the fallback as authoritative would raise a false
change-of-key alarm.

**The entry condition to that second pass is the part that bites.** ssh runs it only when the
port-qualified lookup matched no plain entry of ANY key type — not "no match". Gating it on
"no match and no same-type mismatch" reaches the bare line when an off-port entry of another type
exists, and returns `match` where ssh prints `IDENTIFICATION HAS CHANGED`: an accept-a-changed-key
path, reproduced live. And the observations from each pass must not leak into the other, or an entry
found only on the fallback refuses a host ssh accepts as first contact.

**`HostKeyAlias` suppresses the port entirely.** ssh looks the alias up bare and never brackets it,
so an alias gets ONE pass regardless of port. Combined with the rule above, a stale `[alias]:port`
line would otherwise block the bare lookup ssh actually performs — turning the bastion case this
feature cites `HostKeyAlias` for into a hard failure.

**Hashed entries hash the candidate form, not the bare host** — `[example.com]:2222` is what gets
HMAC'd for a bracketed entry, so each candidate must be hashed separately.

**Multiple files union.** Any exact hit in any file wins; a disagreeing entry in another file does
not make it a mismatch. Confirmed live in both orderings.

**A `@cert-authority` line whose key equals the presented plain host key is not a match** — a CA line
only validates certificates. A normal line alongside it still decides. But ssh's verdict for a
CA-covered host presenting a plain key is `HOST_NEW`, not a failure: it connects. See D4.

### D3. Six outcomes, and type scoping is only safe with algorithm ordering

`match | mismatch | revoked | ca-only | unknown-type-known-host | unknown`.

Mismatch is scoped to the same key type: a host with only an RSA entry that presents ed25519 is not
"changed". Without scoping we would false-alarm nearly every RSA-era user on their first upgraded
connect, training them to dismiss the one warning that matters.

> **Corrected against a live client.** The premise above is wrong about OpenSSH, though the
> conclusion survives. `check_key_in_hostkeys` is not type-scoped at all: ANY non-marker entry for
> the host that is not byte-equal produces `HOST_CHANGED`. Verified on 127.0.0.1:2223 — `known_hosts`
> holding only `ssh-rsa` against an ed25519-only server prints `IDENTIFICATION HAS CHANGED` and
> refuses. So ssh does not avoid the false alarm by scoping; it avoids the _situation_ via
> `order_hostkeyalgs`, and hard-fails when the situation arises anyway. Our split into `mismatch`
> and `unknown-type-known-host` therefore only chooses the wording — both refuse, which is ssh's
> action. What the ordering below buys us is what it buys ssh: the situation mostly never arises.

**But scoping alone is a downgrade vector, and this is the correction that most changes the design.**
OpenSSH is safe here only because `order_hostkeyalgs()` reorders the client's proposed host-key
algorithms to put the types already in `known_hosts` first, and RFC 4253 gives the _client's_ order
priority — so a server cannot choose a type the client deprioritised. ssh2 negotiates ed25519 first
regardless. An attacker who cannot forge the RSA key on file simply presents ed25519 and receives a
friendly first-contact prompt instead of a hard failure.

Therefore: **set ssh2's `algorithms.serverHostKey` to lead with the key types already known for that
host.** Type scoping without algorithm ordering is not a safe design.

And when the presented type is unknown _while other types are known for this host_, that is
`unknown-type-known-host` — never a plain TOFU prompt. It must say we already hold a different key
for this host.

### D4. Outcomes

- **match** → connect silently.
- **unknown** → trust-on-first-use (see the phasing below for whether that is silent or prompted).
- **mismatch** → hard fail, no override in the failure surface.
- **revoked** → hard fail, always.
- **ca-only** → ~~hard fail~~ **REVERSED: treated as first contact.** See below.
- **unknown-type-known-host** → treat as suspicious, not first contact.

`StrictHostKeyChecking` is honoured: `no`/`off` accepts unknown but **never persists** and still
hard-fails changed and revoked; `accept-new` persists silently; `yes` denies unknown.

> **`ssh -G` does not report the spelling the user wrote.** StrictHostKeyChecking is rendered through
> `fmt_multistate_int`, which prints the first entry of `multistate_strict_hostkey`, and that table
> lists true/false before yes/no. So `yes` arrives as `true`, `no` and `off` both as `false`; only
> `ask` and `accept-new` pass through unchanged. Matching on `yes`/`no`/`off` matches nothing a real
> config can produce. `UpdateHostKeys` has the same shape (`true`, not `yes`).

**ca-only, reversed after review.** The rejection was stricter than ssh, and the blast radius was
mispriced. An SSH CA user holds ONE line — very often `@cert-authority *` — which matches every
candidate, so EVERY target failed, not just CA-signed ones, including on-demand runtime VMs, and
`StrictHostKeyChecking=no` did not help. `ORCA_SSH_FORCE_SYSTEM_TRANSPORT=1` is read from the
process environment, which an Electron app launched from the Dock or Start Menu does not have, so
the documented escape was unreachable for exactly the people who needed it. And OpenSSH's own
verdict for a CA-covered host presenting a plain key is `HOST_NEW`: it connects. ssh2 cannot
validate certificates at all, so refusing conceded nothing ssh was not already conceding.

The residual risk is accepted, not resolved: for a CA-protected host we take a plain key we cannot
tie to the CA. Certificate support is Phase 2 work. The `ca-only` outcome is still produced and
carried through the decision so the log shows a CA line was involved.

**An unreadable known_hosts connects but records nothing.** A file that EXISTS and will not open is
the absence of evidence, and the common trigger is not exotic — a Windows OneDrive Known Folder Move
placeholder while offline fails with a cloud-file error, not ENOENT. Refusing there broke an
ordinary corporate laptop while blaming a config file that was fine, and was asymmetric with our own
store, which degrades to "nothing trusted" and connects. ssh warns and treats the host as unknown;
so do we — but we write no record, so a first contact we could not check never becomes durable
trust. An ABSENT file is not this case: that is the normal state for a fresh profile and genuinely
means nothing is known.

### D5. Recovery must not live in the failure dialog

A "forget this host key" button _in_ the mismatch dialog is D4's rejected "trust anyway" with one
extra click. Recovery lives in target settings: a separate, deliberate surface, no auto-retry, and it
shows the stored fingerprint so the user is choosing knowingly.

Offer it only when **our** store is what disagreed; when `known_hosts` disagrees, forgetting our
record cannot unblock the connect. Messages, written to avoid naming internals:

> **Ours disagreed** — "The host key for `build-01` changed since you last connected from Orca. If you
> rebuilt or reprovisioned this machine, this is expected." → _Forget the saved key_ / _Cancel_

> **`known_hosts` disagreed** — "The host key for `build-01` does not match the entry in
> `~/.ssh/known_hosts`. `ssh` and `git` will refuse this host too. Run `ssh-keygen -R build-01`." →
> no button, because a button would not help.

### D6. Never prompt on a background reconnect

A prompt only means something when a human initiated the connect. `userInitiated` does not exist on
the connect path today and must be threaded through `connect → attemptConnect → doSsh2Connect`,
defaulting **false**.

Two traps: `useAutomationDispatchEvents.ts:203` and `pty-connection.ts:857` reach `ssh:connect`
without a human click — automation must pass `false`, but **terminal-pane focus reconnects must count
as user-initiated** or terminals die silently. And the denial string must avoid "authentication
failed"/"permission denied", or `isAgentFallbackError`/`isAuthError`
(`ssh-connection-utils.ts:46-61`) misclassifies it and the reconnect ladder retries a decision that
will never change.

### D7. Fail closed — three known fail-open shapes

1. The existing generation/disposed guard at `:1185` has the fail-open shape today: skip recording,
   still `return true`. Post-fix that branch must **deny**.
2. A synchronous throw inside the verifier may not be caught by ssh2 — wrap and `verify(false)`.
3. Any non-`undefined` return accepts immediately (see Traps).

Plus: no prompt channel registered → deny (the load-bearing default lives in `doSsh2Connect`, not in
IPC, so a caller that forgets to wire it cannot accidentally accept); no window → deny; timeout →
deny; dialog dismissed → deny.

### D8. Store shape and scope

Accepted keys are scoped to **host + port + key type**, not target id — aliases point at different
machines, two targets can name one machine, and a re-created target must not lose trust.

The store is a **dedicated file**, not the main persistence blob (`persistence.ts:7088`): a settings
restore or rollback must not silently reset trust. Accept and mismatch events are logged.

`hostKeyFingerprint` is now security-relevant _and_ wire-relevant — it is an isolation namespace sent
to the host (`ssh-relay-session.ts:1298`, `managed-hook-owner-identity.ts:187`). It is `undefined` on
the system transport, so **no trust logic may key off it**, and its format must not change (see
Traps).

## Phasing — ship the defence before the dialog

Review made the case that the riskiest part of this change is not the security model but the modal.
Startup restore fires eager connects for _all_ previously-active targets in parallel (`App.tsx:1041`)
with a 15s timeout, while a prompt would live 120s — N unknown hosts means N stacked dialogs
outliving the timeout that already deferred them. Runtime-owned ephemeral VMs
(`ephemeral-vm-runtime-ssh.ts:31`) dial a freshly provisioned host with a brand-new key on every
launch. Paired-web connects run on the _host desktop_ (`runtime/rpc/methods/ssh.ts:32`), so the
dialog would open on someone else's screen while the web user watches a spinner.

**Phase 1 — no new modal.** Consult `known_hosts` + our store. `match` connects. `unknown` persists
silently with `accept-new` semantics and a passive notification naming the host and fingerprint.
`mismatch` (same type) and `revoked` hard-fail. This is the entire MITM defence with zero prompts,
zero startup storms and zero web hang.

**Phase 2** — the TOFU dialog, `StrictHostKeyChecking` honouring, `ca-only`, `userInitiated`
plumbing, and the D5 settings surface.

Carve-outs required before Phase 1 ships:

- **Runtime-owned ephemeral targets are exempt from persistence** — a new key every launch is
  expected, not suspicious, and recording one would accumulate a row per launch that eventually
  reads as a spurious change. Implemented via `target.owner?.type === 'on-demand-runtime'`.
- **RPC-originated connects: NOT needed in Phase 1, required in Phase 2.** The review asked for
  these to fail fast rather than leave a paired-web user watching a spinner for the 120s prompt
  timeout. That hang is only reachable if a prompt exists, and Phase 1 has none — the decision
  function is pinned by a test asserting it never returns `prompt`. An RPC connect therefore behaves
  exactly like a local one: it accepts and records on first contact, or fails immediately with the
  host-key reason. Adding a fail-fast path now would introduce a failure mode for a hang that cannot
  occur. It becomes load-bearing the moment the dialog lands, and is listed in Phase 2.

  Worth noting for Phase 2: `runtime/rpc/methods/ssh.ts` already swallows the specific error and
  rethrows `getPublicSshError(status)`, so a web client sees a generic failure rather than the
  host-key reason. Pre-existing, but it means the Phase 2 message will not reach the web user
  without a change there too.

## Traps

Each of these makes the fix silently do nothing. All confirmed in our tree.

1. **An `async` verifier defeats it entirely.** ssh2 does
   `const ret = hashCb(key, verify); if (ret !== undefined) verify(ret)`. An async function returns a
   Promise — not `undefined`, and truthy — so ssh2 accepts before our callback settles.
2. **Do not set ssh2's `hostHash`.** It hands the callback a hex digest and discards the raw blob we
   must compare — and it would change `hostKeyFingerprint`'s format, which is a cross-version state
   break, not a local refactor.
3. **The existing test mock calls `hostVerifier(key)` with one argument** and ignores the return
   (`ssh-connection.test.ts:86-91`). Under an async verifier every connect test there breaks. The
   mock must change — flagged deliberately, not rewritten silently.
4. **Validate the blob**: embedded algorithm name must match the line's key-type field; reject empty
   decodes, empty salts, and hashed entries whose hash is not 20 bytes.
5. **`ssh-relay-live-connect.test.ts:59`** constructs a connection with no credential callback —
   headless with no prompt channel must deny, not hang.

## Scope

**In scope, corrected:** IPv6 literals and `[host]:port` bracket parsing. Review was right that this
is a _parser_ requirement, not a scope call — getting it wrong means hosts `ssh` knows come back
`unknown`, which is the prompt-training harm D3 exists to avoid.

**Out of scope, with consequences stated:**

- **`CheckHostIP`** — OpenSSH defaults it off; we form candidates from the hostname only.
- **WSL** — `src/main/ssh/` has no WSL awareness; a distro's `known_hosts` is unreachable, so WSL
  users get first-contact treatment for hosts they already verified.
- **`UpdateHostKeys`** — we read it and use nothing, so we never learn a rotated key, which makes D5
  the routine path for key rotation rather than an exception.
- **Moving SFTP to the system transport** — correct direction, separate change.

## Test plan

**Parser** (against the file format, not our code's shape): plain lines, `host,host2` lists,
`[host]:port` used only when port ≠ 22, IPv6 literals, hashed `|1|salt|hash` with a real computable
vector, `@revoked`, `@cert-authority`, `*`/`?` globs, `!` negation vetoing a whole line, unrecognised
`@marker` skipping the line, malformed lines skipped not fatal, multiple keys per host, CRLF, blank
lines, comments, user file and global file disagreeing.

**Decision function**: all six outcomes; type scoping; revocation resolved before match regardless of
line order; every `StrictHostKeyChecking` value; `no`/`off` never persists.

**Algorithm ordering**: `algorithms.serverHostKey` leads with types on file — the test that makes D3
safe rather than merely scoped.

**Wiring**: unknown persists (Phase 1) without a prompt; match never notifies; mismatch fails with no
accept path; revoked fails; background reconnect denies; aborted connect settles pending verify
false; no prompt channel denies; runtime-owned targets are exempt; the denial string does not match
`isAuthError`; and — catching the worst regression — **the verifier returns nothing**, so a refactor
to `async` reddens a test rather than reaching a user.

**Checked against a live client, not just the file format.** Two assumptions the design leans on were
verified by running an OpenSSH 10.2p1 client against a real `sshd` on `127.0.0.1:2222` and recording
its verdict:

- **The bare-host fallback pass never reports a change.** With `StrictHostKeyChecking=accept-new`, a
  bare line holding a _different_ key, dialed on a non-default port, made ssh connect and append a
  new `[127.0.0.1]:2222` line — first contact, no `IDENTIFICATION HAS CHANGED`. Reporting `mismatch`
  on that pass would refuse hosts ssh connects to happily, and would have looked like the cautious
  choice.
- **`unknown-type-known-host` is ssh's own behaviour.** known_hosts holding `ssh-rsa` while the
  server offers ed25519 makes ssh print `IDENTIFICATION HAS CHANGED` and refuse. So the rejection is
  neither stricter nor laxer than ssh — and treating it as first contact, which a naive type-scoped
  lookup does, is the laxer mistake. It also means `ssh-keygen -R` is the right remedy to name there.

## What Phase 1 shipped, and what review changed

The design above survived implementation. Every defect found afterwards was in the wiring, and the
pattern is worth recording because it repeats: **each one made us either blind or unusable, never
subtly wrong.**

Fixed after review:

1. **Our own store was type-downgradable.** The inline lookup filtered by key type first and could
   only answer match/mismatch/unknown, so a record of a _different_ type read as `unknown`. D3's
   downgrade, applied to the records we create ourselves. Stored types now also feed the algorithm
   ordering — without that the guard is only half present.
2. **We keyed on the Orca label.** `ssh -G` echoes its own argument back as `hostname` when no Host
   block matches, so for a manual target `resolved.hostname` _is_ the label — the one name D2
   forbids. We consulted no entries at all.
3. **A refused key still walked the credential ladder.** ssh2 reports a denial as a generic auth
   failure, so we went on to prompt for the passphrase and hand it to the host we had just refused.
   Rejections are now a typed error recognised before any fallback.
4. **Fail-closed nearly became fail-always.** "No readable `known_hosts`" counted a _missing_ file the
   same as an unreadable one, so a profile that had never connected — everyone's first run — would
   have been refused, and the suite passed only because dev machines have a `known_hosts`.
5. **Ephemeral runtimes were refused for a policy they cannot satisfy.** The carve-out sat below the
   incomplete-sources check, so a HOME-divergent environment turned on-demand runtimes off entirely.

A second review round, run against a live OpenSSH client and sshd rather than against the source,
found five more — and the pattern held: the two that mattered most were both cases where we refused
a host `ssh` connects to, and the worst single defect was that **`StrictHostKeyChecking` had never
been read correctly at all**, so a config saying `yes` was silently accepted AND persisted. See the
D2/D3/D4 corrections above. The lesson worth keeping: every one of these was invisible to unit tests
that fed the code the value a human writes, rather than the value the tool emits.

## Action items (STA-4319)

**Where the message actually lands.** Traced end to end, because a rejection the user cannot read is
a half-shipped feature. Fixed in this branch: the settings card clamped it to one line with no
tooltip, and the terminal reconnect overlay never asked for it at all. Still open:

- **The "Remote Hosts" status bar shows only `Error`.** `SshTargetStatusRow` does not receive the
  error, so the status bar is a dead end for the most likely place a user notices the failure.
- **"Connect again" is the wrong advice for a decision that will never change.** The terminal overlay
  now prints the reason underneath, but its call to action still invites an action that cannot
  succeed. Telling a permanent rejection from a transient fault in the renderer needs a typed reason
  on the wire rather than a string — a remote-wire-compatibility decision, so deliberately deferred.
- **Toasts carry Electron's `Error invoking remote method 'ssh:connect':` prefix.** The repo has
  strippers for exactly this; no SSH call site uses one. Also worth noting sonner auto-dismisses in
  4s, which is short for a message ending in a command the user is meant to copy.

**Before Phase 2:**

- **`UpdateHostKeys` (out of scope above, now the highest-value gap).** We read it and use nothing,
  so a rotated key is a hard failure the user must resolve by hand. Combined with D5 this is the
  routine path for key rotation, and it will be the most common way a legitimate user meets a
  rejection. Decide whether Phase 2 honours it or D5's recovery surface absorbs it.
- **The web user never sees the reason.** `runtime/rpc/methods/ssh.ts` rethrows
  `getPublicSshError(status)` on all three paths, and push events are redacted through
  `getPublicSshState`, so a paired-web client always sees exactly `SSH connection unavailable`.
  Pre-existing, but it makes the Phase 2 dialog message unreachable there without a change. Note the
  redaction is not web-only: any target owned by a paired runtime environment is redacted, so a
  _desktop_ user viewing a remote-Orca-server-owned host gets the same generic string.
- **RPC fail-fast** becomes load-bearing the moment the dialog exists (see Phasing).

**Known gaps that Phase 1 accepts, listed so they are choices and not surprises:**

- **WSL** — a distro's `known_hosts` is unreachable, so WSL users get first-contact treatment for
  hosts they already verified through `ssh` inside the distro.
- **`CheckHostIP`** — candidates are formed from the hostname only.
- **Certificate validation** is still absent — a CA-covered host is now accepted on first contact
  rather than refused (D4), so those users connect, but the CA itself verifies nothing for us.
- **`DEFAULT_SERVER_HOST_KEY_ALGORITHMS`** is a hand-copy of an ssh2 internal. A test pins it, so an
  ssh2 upgrade that changes it fails CI rather than shipping — but the pin has to be honoured, not
  deleted, because ssh2 throws `Unsupported algorithm` and every target stops connecting.

**Rollout:** the first release carrying this is the first time Orca can refuse an SSH connection at
all. Worth a staged rollout or a kill switch: the failure modes we could not find are, by the shape
of the five above, far more likely to be "a legitimate host is refused" than "a bad key is accepted".
