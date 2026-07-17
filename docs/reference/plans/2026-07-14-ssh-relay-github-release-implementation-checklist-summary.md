# SSH Relay Runtime Distribution — Short Implementation Checklist

Last updated: 2026-07-17

Use this file to track the project. The
[detailed evidence ledger](./2026-07-14-ssh-relay-github-release-implementation-checklist.md)
keeps commands, hashes, runner identities, timings, and failure details.

A checked box means the work has evidence in the detailed ledger. Design approval alone does not
complete a box.

Active checkpoint: **Milestone 6 / Work Package 5 — executable-name versus large-file diagnostic
locally green, native qualification next, 2026-07-17, Codex implementation owner.** Exact matched-buffer head
`d7fcdb25972390bee5b97d495bf605845bcee364`, run `29566111327`, and x64/ARM64 jobs
`87838990171`/`87838990156` both transfer `.version` and the full license, then stall at
180,843/180,845 bytes on `bin/node.exe`. Transfer the exact authenticated Node bytes once to a
neutral `.bin` path; focused, broad, typecheck, lint/reliability/max-lines, formatting, diff, and
resolver isolation pass. Do not change staging semantics before both architectures classify the cause.
No product/default caller, Beta, fallback, tuple, publication, or signing behavior is authorized.
`E-M6-WINDOWS-SYSTEM-SSH-TREE-LIVE-PORTABLE-FIXTURE-LOCAL-001` records the portable-fixture
correction locally green: the no-Orca-publication workflow oracle permits the one exact pinned
Microsoft fixture release URL while Orca release URLs, `gh release`, and `contents: write` remain
forbidden; 10/10 focused workflow contracts, 283/283 release contracts, 694 relay cases with ten
declared skips, typecheck, full lint/reliability/max-lines, PowerShell syntax, formatting, diff, and
protected-resolver isolation pass. Fresh exact-head x64/arm64 proof is still required.
`E-M6-WINDOWS-SYSTEM-SSH-TREE-LIVE-LIBCRYPTO-CI-RED-001` records exact head
`bcbd9d6b36dc8cc2e917fa88eb30f87ab1d88657`, artifact run `29538044827`, and native x64/arm64 jobs
`87753850628`/`87753850663`: both archive hashes pass, but the one-subject Authenticode policy rejects
the official bundle's `libcrypto.dll`; both teardowns pass before any account/service creation.
`E-M6-WINDOWS-SYSTEM-SSH-TREE-LIVE-LIBCRYPTO-CORRECTION-LOCAL-001` records the role-based trust
correction locally green under the initial hypothesis: exact 15-file native closure, both library
hashes, 10/10 workflow contracts, 283/283 release contracts, typecheck, full
lint/reliability/max-lines, and PowerShell syntax pass. Exact head
`85731b3feff90047f67b716363b1549b0d79ee2c`, artifact run `29539266437`, and x64 job
`87757772975` disprove only the guessed `NotSigned` policy: the archive/hash/closure gates pass,
`libcrypto.dll` is target-natively `Valid`, and ownership-safe teardown passes. ARM64 job
`87757772957` independently reports the same exact RED after all prior gates and also passes teardown.
`E-M6-WINDOWS-SYSTEM-SSH-TREE-LIVE-SIGNER-AUDIT-001` records both pinned archives and all 30 PE
assessments: `libcrypto.dll` uses the expected Microsoft 3rd Party common name and exact leaf thumbprint
`587116075365AA15BCD8E4FA9CB31BE372B5DE51`; every executable uses the expected Microsoft Corporation
common name plus audited thumbprint `F5877012FBD62FABCBDC8D8CEE9C9585BA30DF79` or
`3F56A45111684D454E231CFDC4DA5C8D370F9816`.
`E-M6-WINDOWS-SYSTEM-SSH-TREE-LIVE-EXACT-SIGNER-CORRECTION-LOCAL-001` implements that fixture-only
policy and is locally green: 10/10 focused workflow cases with one declared live skip, all three
PowerShell blocks parsed, 283/283 artifact contracts, typecheck, full lint/reliability/max-lines,
formatting, diff, and protected-resolver isolation. Commit/push the isolated correction and require
fresh exact-head native x64/arm64 proof. Exact head
`130d57d951b5e5cfb0e1e21183ce116684924e2b`, artifact run `29540409361`, and x64 job
`87761260157` prove the complete exact-signer policy before exposing a narrower ACL RED: portable
OpenSSH rejects the host key because `icacls /grant:r` did not remove the key creator's explicit
runner-account ACE. Service start fails, and ownership-safe teardown passes. ARM64 job `87761260166`
independently reaches the same RED with creator SID
`S-1-5-21-1882319117-3219095328-2125279949-500`; its teardown also passes. Remove the known creator
SID, assert the exact allowed SID closure, and rerun.
`E-M6-WINDOWS-SYSTEM-SSH-TREE-LIVE-PORTABLE-ACL-CORRECTION-LOCAL-001` records that isolated
correction locally green: protected allow-only ACLs remove the creator and require exact trustee SID
closure; 10/10 focused workflow cases, all three PowerShell blocks, 283/283 artifact contracts,
typecheck, full lint/reliability/max-lines, format, diff, and protected-resolver isolation pass. Push
for fresh exact-head x64/arm64 proof. Exact head
`d28552f0d953e40d96a4c24cdcdb5ba7d85b7c9f` is pushed; artifact run `29541119819` is RED after
independently proving all archive/hash/closure/signer/build/cache gates. Windows x64 job
`87763404467` starts OpenSSH 10.0p2, proves PowerShell 5.1 and pinned-key authentication, then the
production system-SSH connection probe times out before transfer metrics; teardown also detects a
loaded fixture profile instead of silently leaving it. Windows ARM64 job `87763404492` stops earlier
at the exact ACL oracle because the C: fixture root retains explicit Authenticated Users and Users
ACEs in addition to the intended SYSTEM, Administrators, and fixture-user closure; ownership-safe
teardown passes. Diagnose and correct both fixture-exposed contracts, preserving connection reuse
and bounded deterministic teardown, then require fresh exact-head x64/arm64 proof.
`E-M6-WINDOWS-SYSTEM-SSH-TREE-LIVE-EXACT-HEAD-CORRECTION-LOCAL-001` records the three bounded
corrections locally green: the no-input production probe closes native OpenSSH stdin, fixture DACLs
are atomically replaced with exact protected allow-only rules independent of drive defaults, and an
owned `Win32_UserProfile` is deleted through a bounded native lifecycle before account/filesystem
teardown. Focused tests pass 71 cases with one declared live skip, all three PowerShell blocks parse,
all 283 artifact contracts pass, typecheck and full lint/reliability/max-lines pass, formatting/diff
are clean, and the protected resolver files remain unchanged. Exact head
`b652c1ebcce3803443d84c89811146366cdbdd5b` is pushed. Artifact run `29542292712` preserves all
non-Windows gates and independently reaches the Windows fixture on x64, but job `87766845800` is
RED: exact ACL replacement, official OpenSSH setup, authentication, and PowerShell 5.1 pass before
the production probe times out after 32.064 seconds. Closing the Node stdin pipe is insufficient;
the no-input probe needs native OpenSSH `-n` without disabling connection reuse. Teardown also
finds the owned fixture SID's `UsrClass.dat` hive still loaded after the bounded profile-removal
loop. Add probe-only `-n`, boundedly unload only that SID's `_Classes` and primary hives before
retrying `Win32_UserProfile` removal, and require fresh x64/arm64 live proof before advancing.
ARM64 job `87766845741` independently reaches the same boundary: official OpenSSH setup passes,
the production probe times out after 34.01 seconds, and teardown catches the same owned
`UsrClass.dat` lock after the bounded profile loop. This is a shared native OpenSSH/profile
lifecycle correction, not an x64-only exception.
`E-M6-WINDOWS-SYSTEM-SSH-TREE-LIVE-NOINPUT-PROFILE-CORRECTION-LOCAL-001` records the narrow
correction locally green: only the no-input connection probe emits OpenSSH `-n` before `--`, reuse
flags remain enabled, ordinary commands exclude `-n`, and teardown boundedly unloads only the
fixture SID's `_Classes` and primary hives before retrying native profile deletion. The Windows
workflow oracle is split by concrete domain responsibility without a max-lines bypass. Focused
tests pass 115 cases with one declared native skip, all three PowerShell blocks parse, 283/283
artifact contracts pass, typecheck and full lint/reliability/max-lines pass, formatting/diff are
clean, and the protected resolver files remain unchanged. Exact head
`8ae6dcf6450b5f081788357dd8fe776293fb0cfe` is pushed; artifact run `29543292239` is in progress
with native x64 job `87769913124` and ARM64 job `87769913148` assigned. Fresh service/auth/
full-size/cancellation/collision/reuse/teardown proof remains required before advancing.
X64 job `87769913124` is RED after preserving every earlier gate and starting official OpenSSH:
the probe still reports `System SSH connection timed out` after 31.337 seconds despite `-n`.
Teardown proves the owned `_Classes` hive exists but `reg.exe unload` returns exit 1, then catches
the same locked `UsrClass.dat`. Record native process exit/stdout-end/sentinel/channel-close state
and settle fixture-user session processes before the hive loop. ARM64 job `87769913148`
independently reproduces the same boundary: probe timeout after 31.06 seconds, `_Classes` unload
exit 1, locked `UsrClass.dat`, and retained profile directory. Do not advance the milestone on
this result.
`E-M6-WINDOWS-SYSTEM-SSH-TREE-LIFECYCLE-DIAGNOSTIC-LOCAL-001` is locally green: timeout errors
record only sentinel/stdout-end/process-exit/channel-close state, and fixture teardown enumerates
and boundedly terminates only processes whose native owner SID exactly matches the account created
by the fixture before attempting hive unload. Focused tests pass 115 cases with one native skip,
all three PowerShell blocks parse, 283/283 artifact contracts pass, typecheck and full
lint/reliability/max-lines pass, formatting/diff are clean, and protected resolvers are unchanged.
Exact head `e4bcee3f3561e7cfd58aa90e7d35e6c597df8692` is pushed; artifact run `29544129779` is in
progress with x64 job `87772490863` and ARM64 job `87772490900`. Do not treat the local oracle as
native proof.
X64 job `87772490863` is diagnostic RED after official OpenSSH authentication and remote command
session close: `sentinel=false`, `stdoutEnded=false`, `processExit=not-observed`, and
`channelClosed=false`. The client-side no-input process must receive an OS-level ignored stdin
handle in addition to `-n`; preserve piped stdin for every payload-bearing command. ARM64 job
`87772490900` independently returns the same four-field lifecycle tuple after a 31.16-second test,
so the correction is shared across native Windows architectures.
`E-M6-WINDOWS-SYSTEM-SSH-TREE-OS-NOINPUT-LOCAL-001` records a locally green but native-falsified
hypothesis: giving every no-input command an ignored OS stdin handle preserves the payload paths,
but exact run `29544909117` proves the design is unsafe. Linux x64/ARM64 jobs
`87774941240`/`87774941211` observe an argument-less synthetic channel close before child close;
native Windows x64 job `87774941207` reproduces Win32-OpenSSH issues #856/#1330 by executing the
remote command but hanging with all four lifecycle fields false; ARM64 job `87774941200`
independently returns the same lifecycle RED. The corrected POSIX contract uses a separate no-input
`Writable` facade so ending it cannot half-close the command channel. Exact correction head
`4f57b885d24ad1755a5c863eaf37369208cecedb`, artifact run `29545688003`, and Linux x64/ARM64
jobs `87777401256`/`87777401218` are green through live SFTP and restricted no-tar POSIX system
SSH. Windows x64/ARM64 jobs `87777401200`/`87777401195` reproduce the unchanged four-field timeout
with a standard pipe plus mandatory `-n`. Exact diagnostic head
`da938a7405d0a6c760979358a6c0a38030d9acaf`, artifact run `29546702916`, and Windows x64/ARM64 jobs
`87780486286`/`87780486259` prove that inherited and overlapped handles also time out when every
candidate retains `-n`; the invalid inherited control and shared `-n` mean these runs do not isolate
the child handle. `E-M6-WINDOWS-NOINPUT-HANDLE-DIAGNOSTIC-CI-RED-001` therefore requires the next
single-variable diagnostic to use the upstream-recommended standard stdin pipe with immediate EOF
and omit `-n` only on Windows. POSIX retains ignored stdin plus `-n`; production stays unchanged
until x64 and ARM64 select the same console-independent strategy. The replacement disconnected
diagnostic is locally green under `E-M6-WINDOWS-NOINPUT-PIPE-NO-N-LOCAL-001`; commit and run that
exact head next. Exact pushed head `daffd545d75570f198db093c3ba054ae1fa033ba` is under test in
artifact run `29547488550`, Windows x64 job `87782833321`, and Windows ARM64 job `87782833288`.
`E-M6-WINDOWS-NOINPUT-PIPE-NO-N-CI-RED-001` records the completed native result: both architectures
time out at 8.03/8.04 seconds with no sentinel and exact profile RED. Next test only an overlapped
stdin pipe with ordinary stdout/stderr and no `-n`; production remains unchanged. That replacement
diagnostic is locally green under `E-M6-WINDOWS-NOINPUT-OVERLAPPED-NO-N-LOCAL-001`; commit and run
the exact head next. Exact pushed head `1c391aa851777f36cf81af9adb85d7177d7acff6` was tested in
artifact run `29548340927`, Windows x64 job `87785371486`, and Windows ARM64 job `87785371526`.
`E-M6-WINDOWS-NOINPUT-OVERLAPPED-NO-N-CI-RED-001` records the completed native result: x64/ARM64
time out after 8035.00/8043.47 milliseconds with no sentinel, ended stdout, zero stderr, and only
termination settlement; both exact profile teardowns are RED. All four non-Windows primary jobs
and both Linux oldest-userland supplements remain green. Next qualify only a newly created
zero-length regular-file descriptor as Windows stdin, already at EOF before `CreateProcess` and
distinct from `NUL`; do not add a launcher unless this narrower boundary is falsified. Require both
architectures to pass the diagnostic, full-size live transfer, cancellation, reuse, and exact
profile teardown before changing production. `E-M6-WINDOWS-NOINPUT-REGULAR-FILE-NO-N-LOCAL-001`
records the disconnected replacement locally green: focused 117+2, all 283 release contracts,
typecheck, full lint/reliability/max-lines, and formatting pass. Commit/push this exact isolated
diagnostic and require fresh native x64/ARM64 proof. `E-M6-WINDOWS-NOINPUT-REGULAR-FILE-NO-N-CI-RED-001`
records exact pushed head `eee686d7f6203c88f00d607711d3816aaf444c61`, artifact run
`29549252407`, Windows x64/ARM64 jobs `87788106340`/`87788106351`, and independent
8036.46/8042.17-millisecond timeouts despite `stdinFixtureRemoved=true`; both profile teardowns are
RED. All four non-Windows primary jobs and both Linux supplements remain green. Next implement only
a disconnected Windows launcher artifact with private anonymous stdio pipes, exact handle
inheritance, hidden child creation, bounded output pumps, exit propagation, and job-owned
cancellation. `E-M6-WINDOWS-NOINPUT-LAUNCHER-LOCAL-001` records that artifact-only package locally
green: focused 119/119, release contracts 285/285, typecheck, full lint/reliability/max-lines,
formatting, diff, and resolver isolation pass. Its Windows-native suite requires legacy-compiler,
argv/EOF/binary/exit, unrelated-handle exclusion, job cancellation, and bounded settlement proof;
all four native cases are declared skips locally. Commit/push this exact package and require x64/
ARM64 live evidence next. Do not package or call it from production; SignPath remains deferred.
`E-M6-WINDOWS-NOINPUT-LAUNCHER-COMPILE-CI-RED-001` records exact head `1f220a713`, run
`29550660572`, and independent x64/ARM64 jobs `87792250731`/`87792250710`: both legacy compilers
reject one constant/structure identifier collision before emitting an executable. The isolated
correction renames only the integer information-class constant; focused 12/12 and release contracts
285/285 pass locally. Corrected exact head `6a716de14`, run `29551003702`, and x64/ARM64 jobs
`87793308016`/`87793308044` then pass legacy compilation and every native launcher contract plus the
complete 101-file/859-case artifact contract step, but the live diagnostic still times out after
8024.0679/8031.6544 milliseconds. Both observe ended stdout, a closed SSH channel, no sentinel or
process exit, and zero stderr; both exact profile teardowns remain RED on locked `UsrClass.dat`.
`E-M6-WINDOWS-NOINPUT-LAUNCHER-LIVE-CI-RED-001` therefore falsifies Node's pipe type and broad
inherited-handle leakage. Next test only a hidden launcher-owned real-console stdin with console EOF
queued before child creation while retaining private output pipes, exact handle inheritance, job
ownership, and bounded cancellation. Keep it runner-temp-only and disconnected from product;
SignPath remains deferred.
`E-M6-WINDOWS-PRIVATE-CONSOLE-LOCAL-001` records the replacement candidate locally green. It
captures launcher output before detaching, allocates and hides a private console, queues Ctrl+Z plus
Enter into `CONIN$` before child creation, and shares that console with the suspended/job-owned SSH
child while retaining private output pipes and the exact three-handle list. A dedicated native probe
requires character-device stdin, successful `GetConsoleMode`, and a zero-byte cooked `ReadFile`.
Focused 119/119 with seven native skips, all 285 release contracts with five native skips, typecheck,
full lint/reliability/max-lines, formatting, diff, and protected-resolver isolation pass. Commit/push
this artifact-only package and require fresh x64/ARM64 compiler, console/EOF, launcher, live SSH, and
exact teardown proof; no product, Beta, fallback, tuple, publication, default, or SignPath work is
included.
Exact head `5841b12bc`, run `29552101635`, and native x64/ARM64 jobs
`87796673326`/`87796673353` prove the console prerequisites on both architectures: each passes 101
files/860 runnable cases with 19 skips, legacy compilation, character-device `CONIN$`, zero-byte
cooked `ReadFile`, argv/binary/exit/handle-exclusion/cancellation, unchanged runtime reproducibility,
and full-size cache gates. The live client still times out after 8025.1553/8034.6943 milliseconds
with the same no-sentinel/no-exit lifecycle, and both exact teardowns catch locked `UsrClass.dat`.
`E-M6-WINDOWS-PRIVATE-CONSOLE-CI-RED-001` therefore falsifies stdin alone and leaves private output
pipes as the next isolated handle variable. Keep console EOF, replace only child stdout/stderr with
per-stream size-bounded delete-on-close regular files, replay bytes incrementally after exit, and
prove overflow/cleanup/cancellation plus live x64/ARM64 behavior. ConPTY and alternate SSH clients
remain later decisions; all production/Beta/fallback/tuple/publication/default/signing paths remain
untouched.
`E-M6-WINDOWS-PRIVATE-CONSOLE-REGULAR-OUTPUT-LOCAL-001` records that replacement locally green:
distinct parent-read and inheritable child-write regular-file handles avoid shared seek state; each
stream has a 16 MiB ceiling with 50 ms polling, delete-on-close plus explicit cleanup, and 64 KiB
post-exit binary replay after bounded job settlement. Syntax, focused 119/119, all 285 release
contracts, typecheck, full lint/reliability/max-lines, formatting, diff, and protected-resolver
isolation pass. Seven native
launcher cases plus live/full-size behavior remain honest local skips. Commit/push only this
runner-temp diagnostic and require fresh exact-head Windows x64/ARM64 compilation, overflow,
cleanup, cancellation, live lifecycle, and fixture-teardown proof. SignPath remains deferred.
Exact head `149a122b735659b47d7718f409d14e1ed2f947c2`, run `29553325782`, and x64/ARM64 jobs
`87800290122`/`87800290144` prove 101 files/862 cases with 19 skips, including both new overflow and
capture-cleanup cases, plus unchanged reproducibility and full-size cache gates. The live probes
still time out after 8017.5611/8042.1902 ms with ended stdout, closed channel, no sentinel/process
exit, and zero stderr; both exact teardowns catch locked `UsrClass.dat`. All four non-Windows jobs
and both Linux supplements pass. `E-M6-WINDOWS-PRIVATE-CONSOLE-REGULAR-OUTPUT-CI-RED-001` therefore
falsifies output pipes as the remaining cause. Next add only an internal diagnostic deadline and
bounded replay of verbose OpenSSH output before choosing ConPTY or another client. Production,
Beta, fallback, tuple, publication, default, and signing paths remain untouched.
`E-M6-WINDOWS-VERBOSE-LIFECYCLE-CAPTURE-LOCAL-001` records that diagnostic locally green: an
optional 100-60,000 ms runner-only deadline terminates and settles the owned job before bounded
output replay; the live suite uses 6 seconds, `-vvv`, outer 8/10-second safety ceilings, and a 16 KiB
trace tail. Focused 119/119, all 285 release contracts, typecheck, full lint/reliability/max-lines,
formatting, diff, and protected-resolver isolation pass with honest native skips. Commit/push only
this artifact and require x64/ARM64 phase classification before selecting ConPTY or another client.
Exact head `b24dda744892c2ee43a3fb345d889ba97adb4239`, run `29554073553`, and Windows x64/ARM64
jobs `87802525440`/`87802525442` prove 101 files/863 cases with 19 skips plus the internal timeout,
replay, and job-termination contracts. Both 6111.6731/6395.98-millisecond traces stop before
authentication at `hostkeys_find_by_key_hostfile`: Win32-OpenSSH looks under the runner account
instead of the isolated fixture client home. `E-M6-WINDOWS-VERBOSE-LIFECYCLE-CAPTURE-CI-RED-001`
therefore replaces the prior session-close hypothesis with one narrower correction: pass only the
fixture's exact pinned `known_hosts` with strict checking. Both profile teardowns still catch locked
`UsrClass.dat`; all four non-Windows jobs and both Linux supplements pass.
`E-M6-WINDOWS-DIAGNOSTIC-HOST-TRUST-CORRECTION-LOCAL-001` records that correction locally green:
the purpose contract proves `-vvv`, `StrictHostKeyChecking=yes`, and the exact fixture
`UserKnownHostsFile` occur before `--`, rejects `StrictHostKeyChecking=no`, and compares against an
unchanged production argument vector. Focused 120/120, all 285 release contracts, typecheck, full
lint/reliability/max-lines, formatting, diff, and protected-resolver isolation pass with honest
native/live skips. Commit/push only this runner diagnostic and require fresh x64/ARM64 strict-trust,
authentication, natural settlement, full-size transfer, and exact teardown proof. Production,
Beta, fallback, tuple, publication, default, and signing paths remain untouched.
Exact head `a6feb8c3be0e15ae45fc6b431c1665e5fd84d2c9`, run `29554814775`, and Windows x64/ARM64 jobs
`87804630533`/`87804630504` prove the strict diagnostic succeeds in 884.6485/707.1382 ms with the
sentinel, ended stdout, natural exit/close 0, and exact pinned trust. The unchanged direct-spawn
product probe then times out in 31113/30963 ms with all lifecycle fields unobserved after server-side
authentication and command-session close. `E-M6-WINDOWS-DIAGNOSTIC-HOST-TRUST-CI-RED-001` selects
the proven private-console/bounded-regular-output launcher on both architectures and authorizes only
an explicitly injected launcher-path adapter. Core code must not read the workflow environment;
when no path is supplied, existing behavior remains exact. Full-size, cancellation, concurrency,
reuse, and teardown proof remain required before packaging or any product/Beta/default caller.
`E-M6-WINDOWS-SYSTEM-SSH-TREE-LIVE-AUDIT-001` fixes the loopback-only official Microsoft
server, fixture-owned non-admin account/ACL, exact host-key trust, Windows PowerShell 5.1,
serial/default and four-channel metrics, cancellation/collision/cleanup, and deterministic teardown
contracts. `E-M6-WINDOWS-SYSTEM-SSH-TREE-LIVE-LOCAL-RED-001` proves the purpose suite skips without
native inputs, the existing workflow oracle passes 9/9, and the new case fails only because the
audited start step is absent. Add only start/measure/stop wiring, then require native x64/arm64
evidence. Product callers, legacy upload/fallback/default behavior, tuple enablement, publication,
and SignPath remain out of scope.

Pre-push fixture review found that native Windows `sshd.exe` requires the fixed `sshd` service name.
The corrected audit uses only a collision-checked, ownership-marked fixed-name fixture service.

`E-M6-WINDOWS-SYSTEM-SSH-TREE-LIVE-LOCAL-001` records the final local package green: 10/10 workflow
contracts with one honest live-suite skip, 259 focused passes with five skips, 694 broad relay passes
with ten skips, 283/283 release contracts, typecheck, full lint, 355-entry max-lines ratchet,
PowerShell syntax, formatting, isolation, and protected-resolver checks pass. Native x64/arm64
capability, ACL, full-size, cancellation, and teardown proof remains required before this package
closes.

`E-M6-WINDOWS-SYSTEM-SSH-TREE-LIVE-CI-RED-001` records exact-head x64 job `87745066045`: every
prior build/runtime boundary and native capability/config step passes, but Windows `sshd` rejects
the generated host private key because its owner remains the runner account despite narrow SYSTEM/
Administrators ACL entries. Ownership-marked teardown restores the stock service and passes. Set
that key's owner to LocalSystem and `authorized_keys` owner to the fixture user, without broadening
ACLs or changing production behavior, then rerun both native architectures.

`E-M6-WINDOWS-SYSTEM-SSH-TREE-LIVE-OWNER-CORRECTION-LOCAL-001` records that exact owner correction
locally green: 10/10 workflow and 283/283 release contracts, PowerShell syntax, targeted lint,
formatting, diff, and protected-resolver checks pass; the live suite remains one honest local skip.
Preserve the original arm64 result, then push for fresh x64/arm64 proof.

`E-M6-WINDOWS-SYSTEM-SSH-TREE-LIVE-ARM64-CAPABILITY-CI-RED-001` records arm64 job `87745066052`:
all prior native build/runtime gates pass, but `Add-WindowsCapability OpenSSH.Server` emits no result
for 19m16s and the existing 30-minute job cancels it; ownership-safe teardown still passes. Do not
increase the timeout. Provision the same immutable official Microsoft Win32-OpenSSH release on both
architectures with per-architecture archive and sole-upstream-library SHA-256 pins, role-based
target-native Authenticode, bounded download, fixed-name service ownership/deletion, and no
production or remote-host HTTP behavior.
`E-M6-WINDOWS-SYSTEM-SSH-TREE-LIVE-PORTABLE-FIXTURE-LOCAL-001` closes the local correction gate;
push its exact head and require both native architectures before closing the live Windows package.
`E-M6-WINDOWS-SYSTEM-SSH-TREE-LOCAL-RED-001` proves the native workflow oracle passes 9/9 and the
purpose suite fails solely because the audited production tree-composition module is absent.
`E-M6-WINDOWS-SYSTEM-SSH-TREE-LOCAL-001` records 8/8 purpose and 9/9 workflow-oracle cases, 258
focused passes with three declared skips, 694 broad relay passes with nine declared skips, 282/282
release contracts, typecheck, full lint, formatting, max-lines, diff, protected-resolver, and
no-product-consumer gates. The following exact-head native evidence closes its CI gate.
`E-M6-WINDOWS-SYSTEM-SSH-TREE-CI-001` closes that gate at exact implementation head `139bcd16d3`:
all six primary native jobs, both Linux supplements, Windows x64 floor, PR Checks, Golden E2E, and
computer-use pass. Windows arm64 retains only hosted build 26200 versus required 26100 after complete
85,213,511-byte runtime/Node/PTY/watcher/resource proof. This does not prove live Windows OpenSSH.
`E-M6-WINDOWS-SYSTEM-SSH-CONTROL-LOCAL-RED-001` proves the native workflow oracle passes 9/9 and
the purpose suite fails solely because the audited production staging-control module is absent.
`E-M6-WINDOWS-SYSTEM-SSH-CONTROL-LOCAL-001` records 16/17 purpose cases locally with the real
PowerShell case honestly skipped, 207 focused cases, 686 broad relay cases, 282/282 release
contracts, typecheck, full lint, formatting, diff, protected-resolver, and no-product-consumer
gates. Native Windows x64/arm64 `powershell.exe` proof remains required.
`E-M6-WINDOWS-SYSTEM-SSH-CONTROL-CI-001` closes that native gate: Windows x64/arm64 pass all
17 staging-control cases through real `powershell.exe`; all six primary cells, both Linux
supplements, Windows x64 floor, PR Checks, Golden E2E, and computer-use pass after an unchanged
Darwin x64 toolchain-timeout rerun. Windows arm64 retains only hosted build 26200 versus required
26100 after complete runtime smoke.
`E-M6-WINDOWS-SYSTEM-SSH-FILE-LOCAL-RED-001` proves the workflow oracle passes 9/9 and the new
purpose suite fails solely because the audited production destination is absent.
`E-M6-WINDOWS-SYSTEM-SSH-FILE-LOCAL-001` records 14/15 Windows purpose cases locally with the real
PowerShell case honestly skipped, all 25 prior POSIX destination cases, 234 focused cases, 670 broad
relay cases, 282/282 release contracts, typecheck, full lint, formatting, diff, protected-resolver,
and no-product-consumer gates. `E-M6-WINDOWS-SYSTEM-SSH-FILE-CI-001` closes native proof: Windows
x64 and arm64 each pass all 15 cases through real `powershell.exe`; all six primary jobs, both Linux
supplements, Windows x64 floor, PR Checks, Golden E2E, and computer-use pass. The same-SHA rerun
closes an adjacent watcher flake and retains only the declared hosted Windows arm64 build-26200
versus required-26100 rejection after complete runtime smoke.
`E-M6-POSIX-SYSTEM-SSH-TREE-AUDIT-001` requires a bounded no-input control-command owner rather than
the legacy unbounded-output command helper, exclusive `0700` root creation, parent-first declared
directories, exact per-file source-stream composition, owned-root cleanup, and a worst-case
cancellation/cleanup join below 10 seconds. It remains disconnected and defaults to one channel.
`E-M6-POSIX-SYSTEM-SSH-TREE-LOCAL-RED-001` proves both purpose suites fail solely because the audited
production modules are absent while the native workflow oracle passes 8/8.
`E-M6-POSIX-SYSTEM-SSH-TREE-LOCAL-001` records 15/15 purpose, 219 focused cases with one declared
skip, 656 broad relay cases with six declared skips, 281/281 release contracts, full lint/typecheck,
and static/isolation proof. The new tree owner has no production consumer and the protected legacy
Node/npm resolver diff remains untouched. Live/full-size/high-RTT OpenSSH and every product/default
path remain explicit gaps until later packages.
`E-M6-POSIX-SYSTEM-SSH-TREE-CI-001` proves all 15 purpose cases on all six primary Node 24 native
clients at exact head `ec51e36b7`; both Linux supplements, Windows x64 floor, PR Checks,
computer-use Windows/Ubuntu, and Golden E2E macOS/Linux pass. The artifact run is red only because
the Windows arm64 hosted floor runner is build 26200 instead of required 26100; it first verified the
complete 85,213,511-byte/42-file runtime, ABI 137, PTY, watcher, and two-second settlement. No live
POSIX system-SSH claim follows from these adapter-backed native cases.
`E-M6-POSIX-SYSTEM-SSH-CHANNEL-LOCAL-001` records 13/13
purpose, 150/150 focused, 641 broad relay cases with six declared skips, 281/281 release contracts,
and all static/isolation gates. `E-M6-POSIX-SYSTEM-SSH-CHANNEL-CI-001` proves the 13 cases on all six
primary native clients; both Linux supplements, Windows x64 floor, PR Checks, computer-use Windows/
Ubuntu, and Golden E2E macOS/Linux pass. Windows arm64 retains only the declared hosted build 26200
versus required 26100 rejection after the complete 85,213,511-byte/42-file runtime smoke.
`E-M6-POSIX-SYSTEM-SSH-CHANNEL-AUDIT-001` limits this slice to one already-authenticated system-SSH
`SshConnection.exec()` channel, bounded copied stderr, drained stdout, exact stdin callback/EOF/
settlement, and idempotent SIGTERM/SIGKILL hooks consumed by the proven single per-file cancellation
owner. The adapter prechecks but does not forward that signal into `exec`, avoiding a duplicate
immediate SIGTERM listener.
No direct spawn, legacy uploader change, live claim, or product path is included. Audit only a
disconnected live/full-size POSIX system-SSH proof next; legacy remains the only production/default
path and SignPath remains deferred.
`E-M6-POSIX-SYSTEM-SSH-TREE-LIVE-AUDIT-001` limits that proof to a second loopback-only stock
`sshd` on Linux x64/arm64 artifact runners, exact generated host-key trust, public-key auth, and a
forced remote `PATH` containing only `mkdir`, `chmod`, `cat`, and `rm` plus absolute `/bin/sh`.
It adds only a purpose-named full-size test and workflow/oracle wiring; no production module changes.
`E-M6-POSIX-SYSTEM-SSH-TREE-LIVE-LOCAL-RED-001` proves the live suite skips without its seven CI
inputs while the independent workflow oracle fails only because the audited start/measure/stop
steps are absent. That bounded fixture wiring now passes the local 9/9 workflow oracle while the
purpose suite remains honestly skipped without CI inputs; broad regression gates and exact-head
Linux x64/arm64 live evidence remain required.
`E-M6-POSIX-SYSTEM-SSH-TREE-LIVE-LOCAL-001` records that bounded package locally green: 9/9 workflow
oracle, 220 focused, 656 broad relay, 282 release-contract, typecheck, lint, 355-entry max-lines,
formatting, diff, protected-resolver, and no-product-consumer gates pass. The live case is explicitly
skipped locally and earns no proof; exact-head Linux x64/arm64 live evidence is still required.
`E-M6-POSIX-SYSTEM-SSH-TREE-LIVE-CI-001` closes that live package at exact head `cdc25b2d1`: native
Linux x64 transfers 124,846,430 bytes/34 files in 976 ms serial or 678 ms at four channels; native
Linux arm64 transfers 122,865,324 bytes/34 files in 796 ms serial or 568 ms at four channels. Peak
incremental RSS is 4,956,160 bytes and cancellation settles in 15.6–27.6 ms with no later progress;
both trees, modes, hashes, collision preservation, cleanup, and connection reuse pass against pinned
stock OpenSSH exposing only `/bin/sh`, `mkdir`, `chmod`, `cat`, and `rm`. All six primary native
jobs, both Linux supplements, Windows x64 floor, PR Checks, Golden E2E, and computer-use pass after
one unchanged Ubuntu UI-focus rerun. Windows arm64 retains only hosted build 26200 versus required
26100 after full runtime proof. No product/default path is connected.
`E-M6-POSIX-SYSTEM-SSH-FILE-LOCAL-001` records 25/25 purpose, 628 broad relay, 281/281 release, and all
static/isolation gates.
`E-M6-POSIX-SYSTEM-SSH-FILE-CI-001` proves the 25 cases on all six primary native clients; both Linux
supplements, Windows x64 floor, PR Checks, computer-use Windows/Ubuntu, and Golden E2E macOS/Linux
pass. Windows arm64 retains only hosted build 26200 versus required 26100 after complete runtime
smoke. The module still has no real SSH/tree/product consumer.
`E-M6-SFTP-LIVE-COMPOSITION-CI-001` records complete exact-tree/mode/exclusive-root/cancellation/RSS
proof against stock OpenSSH on native Linux x64 and arm64. The repeated unrelated Windows compiler
timeout is closed at exact head `4945645e8` by computer-use run `29515352845` under
`E-M6-SFTP-LIVE-COMPOSITION-ADJACENT-CI-001`. `E-M6-POSIX-SYSTEM-SSH-FILE-AUDIT-001` limits the next
slice to one injected command channel and one exclusively created manifest file with bounded chunk,
EOF, mode, cancellation, and forced-settlement contracts. No real SSH connection, remote tree,
semantic probe, live/full-size claim, product path, mode/fallback, or default behavior is included.
`E-M6-SFTP-LIVE-COMPOSITION-AUDIT-001` limits this package to one authenticated built-in
`SshConnection`, one raw SFTP channel, the existing one-to-four file transfer, captured-transport-
only force close with awaited teardown, and exact full-size Linux x64/arm64 runtime transfer against
target-native OpenSSH runners. It also requires ordinary cancellation cleanup to run before a short
retained-callback breaker closes the session. No product/default, system-SSH, Windows-remote,
high-RTT, `MaxSessions=1`, or tuple-enablement claim is made. SignPath remains deferred.
`E-M6-SFTP-LIVE-COMPOSITION-LOCAL-001` is locally green: 15/15 purpose cases, 189 focused cases
with two declared skips, 603 broad relay cases with six declared skips, 281/281 release contracts,
typecheck, full lint, formatting, max-lines, diff, protected-resolver, and isolation gates pass. The
full-size live suite is deliberately skipped without runner OpenSSH/runtime inputs, so exact-head
Linux x64/arm64 live CI remains the next gate.
`E-M6-SFTP-SESSION-ADAPTER-CI-001` closes all six primary native jobs, both
Linux supplements, Windows x64 floor, PR Checks, Golden E2E, and computer-use on exact commit
`fbec34cf1`; Windows arm64 retains only the declared hosted build-26200 versus required-26100
rejection after complete runtime smoke. No live SFTP/tree or product/default claim is made.
`E-M6-SFTP-SESSION-ADAPTER-LOCAL-001` passes 9/9 purpose, 70/70 adapter+connection,
182 focused cases with one declared skip, 597 broad relay cases with five declared skips, 280/280
release contracts, typecheck, full lint, formatting, max-lines, diff, protected-resolver, and
isolation gates. No live SFTP/tree or product/default claim is made.
`E-M6-SFTP-SESSION-ADAPTER-AUDIT-001` limits the package to optional-signal channel acquisition,
bound raw operations, raw-close callback settlement, and a five-second grace followed by a required
caller-owned connection-force-close hook. No tree importer or live/product claim is included.
`E-M6-SFTP-TREE-TRANSFER-CI-001` closes all six primary native jobs,
both Linux supplements, Windows x64 floor, PR Checks, Golden E2E, and computer-use on exact commit
`28e7a6e5f`; Windows arm64 retains only the declared hosted build-26200 versus required-26100
rejection after complete runtime smoke. No live SFTP/server or product/default claim is made.
`E-M6-SFTP-TREE-TRANSFER-LOCAL-001` passes 9/9 purpose cases after absolute-
root hardening, 112 focused cases with one declared skip, 588 broad relay cases with five declared skips, 280/280 release
contracts, typecheck, full lint, formatting, max-lines, diff, protected-resolver, and no-product-
import gates. `E-M6-SFTP-TREE-TRANSFER-AUDIT-001` limits the package to one caller-owned signal and session
abstraction, one exclusive staging root, manifest-only directory creation, one-to-four composed file
streams, proved-owned reverse cleanup, and awaited session close. Cancellation starts session close
immediately; a later raw-`ssh2` adapter must prove that close settles retained callbacks. No live
SFTP/server or product/default claim is made. `E-M6-SFTP-FILE-DESTINATION-AUDIT-001` fixes exclusive `wx` open, callback-bounded
positional writes, explicit POSIX mode repair/handle-stat proof, and joined close-before-unlink
cleanup. It deliberately borrows but does not acquire/end an SFTP session and does not create
directories, clean a whole staging tree, or publish/launch anything. Session-wide cancellation,
full-size live SFTP, product/default wiring, and SignPath remain later gates.
`E-M6-SFTP-FILE-DESTINATION-LOCAL-RED-001` records the expected missing-module failure for the
12-case purpose contract; the 7/7 native workflow oracle already pins it once in both command
families. Protected resolvers remain untouched and no production importer exists.
`E-M6-SFTP-FILE-DESTINATION-LOCAL-001` passes the hardened 13-case purpose suite, 103 focused cases
with one declared skip, 579 broad relay cases with five declared skips, 280/280 workflow cases,
typecheck, full lint, targeted format, max-lines, diff, protected-resolver, and no-product-import
gates. It proves the exact per-file lifecycle only; SFTP session/tree orchestration, live/full-size
remote proof, and every product/default path remain open.
`E-M6-SFTP-FILE-DESTINATION-CI-001` closes exact commit `72d482201`: all six primary native clients
pass all 13 cases and complete full runtime proof; both Linux supplements, Windows x64 floor, PR
Checks, Golden E2E, and computer-use pass. Windows arm64 retains only the declared hosted build-26200
rejection against 26100 after complete runtime smoke. The suite uses callback mocks and does not
credit a live SFTP/server/remote cell.
`E-M6-SOURCE-STREAM-CI-001` closes exact commit `df39c287d`: all six primary native clients pass the
27-case source-stream suite (Windows has only the declared POSIX-mode skip), exact 85–125 MB trees
stream in 103.663–530.937 ms with 0–5,492,736 incremental RSS bytes, both Linux supplements and the
Windows x64 floor pass, and PR Checks/Golden E2E pass. The first computer-use Windows attempt hit two
unrelated unchanged five-second launcher timeouts under `E-M6-SOURCE-STREAM-ADJACENT-CI-RED-001`;
its same-SHA failed-job rerun passes the tests, packaged build, daemon smoke, and Windows E2E without
code or timeout changes. Windows arm64 retains only the declared hosted build-26200 rejection against
26100 after complete runtime proof. SFTP/system-SSH channels, remote staging/install/mode repair,
product/Beta/fallback/default wiring, publication, and SignPath remain absent.
`E-M6-SOURCE-STREAM-CI-RED-001` records run `29501986883` / Windows x64 job `87632962424`: the
hostile wrong-mode case incorrectly expected POSIX mode enforcement on Windows, then production
correctly rejected the test's incomplete destination. Linux x64/arm64 and Darwin x64/arm64 purpose
commands passed before cancellation. Make only that case POSIX-only; no production behavior is
relaxed and no cell is credited from the superseded run.
`E-M6-SOURCE-STREAM-WINDOWS-ORACLE-CORRECTION-LOCAL-001` passes 27/27 purpose cases on macOS, 107
focused cases with one declared skip, 566 broad relay cases with five declared skips, 280/280
workflow cases, typecheck, full lint, format, max-lines, diff, protected-resolver, and isolation
gates. Only the POSIX-mode case changed; fresh Windows and all-six native/full-size CI remain
mandatory.
`E-M6-SOURCE-STREAM-AUDIT-001` fixes the next artifact-only boundary: exact scanned tree plus one
signal, maximum four 64-KiB readers, local snapshot proof before destination open, hash/size and
post-read snapshot proof before destination finalization, joined abort/close cleanup, and path-free
aggregate progress. It deliberately contains no SSH, remote path/staging, product caller, setting,
fallback, tuple, publication, or default behavior.
`E-M6-SOURCE-STREAM-LOCAL-RED-001` records the expected missing-module failures for the purpose and
full-size suites plus the workflow oracle's six-pass/one-fail proof that neither native command ran
the new suite.
`E-M6-SOURCE-STREAM-LOCAL-001` passes 27/27 purpose cases, 107 focused cases with one declared skip,
566 broad relay cases with five declared skips, 280/280 release/workflow cases, typecheck, full lint,
targeted format, max-lines, diff, protected-resolver, and no-product-import gates. It proves bounded
one-to-four-worker/64-KiB reads, complete pre-destination snapshots, exact digest/size checks,
hostile metadata and mutation rejection, cancellation, destination uniqueness/completeness, joined
cleanup, path-free progress, lease ownership, and concurrent settlement. The local full-size case
correctly skips without an exact native artifact; all-six native metrics and adjacent CI remain
required before checking the package. No SSH/product/default caller exists.
`E-M6-SOURCE-PRESCAN-AUDIT-001` fixes the next local-only boundary: consume only the accepted source
tree plus one exact signal; assert its borrowed lease; boundedly enumerate and hash every real entry;
reject mutation, symlink/junction, special, missing/extra/colliding, mode/size/hash/aggregate drift;
return frozen bigint state snapshots for mandatory later transfer-time comparisons; and close every
local handle. Full-size latency/RSS/handle proof is required. No remote resource or product path is
introduced.
`E-M6-SOURCE-PRESCAN-LOCAL-001` passes 16 purpose cases with one Linux-only local skip, 79 adjacent
cases, 538 broad relay cases, 280 release/workflow cases, typecheck, full lint, formatting, diff,
protected-resolver, and no-product-import gates. It proves one-directory/one-file/64-KiB bounds,
cancellation and close failures, complete tree hashing, mutation/integrity rejection, frozen state
snapshots, and both native workflow invocations. The local full-size case correctly skips without a
native artifact; exact-head all-six native metrics remain required before checking the item.
`E-M6-SOURCE-PRESCAN-LOCAL-RED-001` records the earlier expected missing-module failures for purpose
and full-size measurement plus the workflow oracle's six-pass/one-fail result.
`E-M6-SOURCE-PRESCAN-CI-RED-001` records the Linux arm64 Node 24 runner finding: `RELAY.JS`
enumerated before signed `relay.js` fails closed as undeclared rather than collision. No SSH or
execution occurs. The remaining artifact run was cancelled after capture; collision classification
must become order-independent and receive fresh all-six native/full-size proof.
`E-M6-SOURCE-PRESCAN-COLLISION-FIX-LOCAL-001` makes the classification independent of enumeration
order and adds a platform-neutral case proving rejection before child metadata access. It passes 17
purpose cases with one Linux-only local skip, 80 focused cases, 539 broad relay cases, typecheck,
full lint, and diff gates. Fresh exact-head Linux and all-six full-size proof remain required.
`E-M6-SOURCE-PRESCAN-CI-001` closes exact correction commit `724ed6295`: all six primary native jobs,
both Linux supplements, Windows x64 baseline, PR Checks, Golden E2E, and computer-use pass. Every
Linux client passes all 18 pre-scan cases; macOS/Windows retain only declared platform skips. Exact
full-size scans cover 34–42 files and 85,213,511–124,846,430 bytes in 145.534–724.753 ms with
81,920–3,239,936 incremental RSS bytes, all within budget. Windows arm64 retains only the declared
hosted build-26200 rejection against 26100 after full Node/PTY/watcher/tree proof. Live SSH,
streaming, remote staging/install, product/mode/fallback/default wiring, publication, and SignPath
remain absent.
`E-M6-SOURCE-TREE-CONTRACT-AUDIT-001` fixes a pure ready-acquisition → immutable descriptor
boundary: exact verified manifest/cache identity and signed limits, deterministic ASCII ordering,
client-native paths, borrowed live-lease assertion, and later shared use by pre-scan plus SFTP,
POSIX tar/no-tar, and Windows PowerShell/.NET transfer. It performs no I/O and owns no cleanup;
filesystem enumeration, streaming, SSH, remote writes/install, product/mode/fallback/default wiring,
publication, and SignPath remain absent.
`E-M6-SOURCE-TREE-CONTRACT-CI-001` closes exact implementation commit `2f38700b9`: all six primary
native Node 24 clients, both Linux supplements, Windows x64 baseline, PR Checks, Golden E2E, and
computer-use pass. Windows arm64 retains only the declared hosted build-26200 rejection against
26100 after complete Node/PTY/watcher/tree proof. Every client passes the ten-case source-tree suite;
Windows totals are 87 files / 680 passed / 14 skipped and POSIX totals are 86 files / 689 passed / one
skip. Full-size extraction/cache metrics remain in budget. Filesystem pre-scan/mutation proof, SSH,
remote writes/install, product/mode/fallback/default wiring, publication, and SignPath remain absent.
`E-M6-SOURCE-TREE-CONTRACT-LOCAL-RED-001` records the expected missing-module failure for ten purpose
cases and the native-workflow oracle's six-pass/one-fail result: the suite occurs only in the oracle,
not either runner command. `E-M6-SOURCE-TREE-CONTRACT-LOCAL-CONTENTION-001` rejects an overlapping
local broad run whose existing suites hit 30-second timeouts under four concurrent heavy commands;
timeouts were not relaxed. `E-M6-SOURCE-TREE-CONTRACT-LOCAL-001` is green after isolated reruns:
10/10 purpose, 85/85 focused, 522/522 broader relay with four declared skips, 280/280 release-script,
typecheck, full lint, format, max-lines, diff, protected-resolver, and no-product-import gates pass.
The pure 123-line module rechecks ready acquisition identity/aggregates/root, freezes deterministic
signed descriptors, and borrows without releasing the live cache lease. Exact-head native proof is
next; filesystem pre-scan/streaming, SSH, remote writes/install, product/mode/fallback/default wiring,
publication, and SignPath remain absent.
`E-M5-ARTIFACT-CACHE-RESOLUTION-CI-001` closes warm-cache commit
`22031fa68` on all six native clients, both Linux supplements, Windows x64 baseline, PR Checks,
Golden E2E, and computer-use; Windows arm64 remains the expected build-26200 rejection against 26100. `E-M5-ARTIFACT-CACHE-RESOLUTION-LOCAL-001` passes 9/9 purpose tests,
16/16 focused+workflow-oracle tests, 323/323 non-full-size SSH relay tests, 280/280 release-script
tests, typecheck, lint, format, reliability, max-lines, localization, and diff gates. Missing trust
and compatibility legacy results perform no cache I/O; a miss returns only the immutable selected
artifact; a verified hit acquires an in-use lease before exposure; corruption and lease failures
propagate closed. No download, Electron/startup, SSH/Beta mode/tuple/publication/default caller
exists. The active package composes only download, existing immutable cache-entry publication, and
in-use lease operations behind an explicit canonical cache root; it adds no Electron/startup,
proxy, SSH/Beta mode/tuple enablement/release publication/fallback/default behavior. SignPath stays
deferred to the final signing gate.
`E-M5-ARTIFACT-CACHE-POPULATION-AUDIT-001` selects cache-local exclusive download staging → existing
strict immutable publication → staging cleanup → in-use lease as the next boundary; the publisher
already owns strict extraction and complete-tree verification, so no second extractor is added.
`E-M5-ARTIFACT-CACHE-POPULATION-LOCAL-RED-001` records the expected missing-module failure before
implementation. `E-M5-ARTIFACT-CACHE-POPULATION-LOCAL-001` passes 9/9 purpose/integration tests,
16/16 focused+workflow-oracle tests, 332/332 non-full-size SSH relay tests, 280/280 release-script tests,
typecheck, lint, format, reliability, max-lines, localization, and diff gates. Every failure remains
unclassified and fail-closed at this layer; exact-head native proof is next.
The first real cold→warm assertion then exposed a logical `/var/...` versus physical
`/private/var/...` lease-root mismatch under `E-M5-ARTIFACT-CACHE-PHYSICAL-ROOT-LOCAL-RED-001`.
The primary plan already requires physical cache ownership, so its content is unchanged; the
implementation now canonicalizes lease identity/locking/recency to the existing physical root under
`E-M5-ARTIFACT-CACHE-PHYSICAL-ROOT-CORRECTION-LOCAL-001`: 7/7 correction tests and 21/21 focused+
workflow-oracle tests pass while missing/misplaced entries remain rejected. Broader exact-head proof
is still required before checkpointing.
Exact-head cold-cache artifact run 29475848463 then repeated the prior Windows x64 active-owner
release race in job 87548519537: the new real Linux/Windows cold→warm integration cases pass, but
lock tombstone rename receives `EPERM` and the live waiter later receives teardown `ENOENT`
(`E-M5-ARTIFACT-CACHE-LOCK-RELEASE-CI-RED-001`). The prior ledger explicitly required correction if
this recurred. The bounded sharing-error correction below is locally green, but replacement all-six
native proof remains required; do not advance to acquisition, Electron/startup, SSH, settings,
fallback, tuple, publication, or default behavior.
`E-M5-ARTIFACT-CACHE-LOCK-RELEASE-LOCAL-RED-001` records the expected missing-module failure for the
fixed bounded retry/displacement/exhaustion contract before implementation.
`E-M5-ARTIFACT-CACHE-LOCK-RELEASE-LOCAL-001` is now locally green: only `EPERM`/`EACCES` rename
failures retry for at most 5 s at 50 ms intervals; every retry rechecks exact directory/nonce
ownership, displacement preserves the successor, absent paths settle, and unexpected or exhausted
failures propagate closed. Focused plus workflow-oracle proof passes 24/24, broader non-full-size
relay proof passes 339/339 with the three declared full-size skips, release scripts pass 280/280,
and typecheck, lint, format, diff, and protected-resolver gates pass. This local evidence was not
sufficient until the replacement exact-head all-six native run and adjacent checks recorded below.
`E-M5-ARTIFACT-CACHE-LOCK-RELEASE-CI-001` now closes correction commit `bd240049f` and accepts the
cold-cache population package: all six primary native Node 24 jobs and both Linux supplements pass;
Windows x64 baseline, PR Checks, Golden E2E, and computer-use pass. Windows arm64 executes the full
runtime smoke and retains only the declared hosted build-26200 rejection against required 26100.
Every primary client passes its contract command and full-size extraction/cache lifecycle; the
repeated Windows x64 lock-release race is closed. The next package is an audit of the smallest
disconnected acquisition composition only. Electron/startup, live proxy/network, SSH, settings,
fallback, tuple enablement, release publication, and default behavior remain absent, and legacy
remains the sole production path.
`E-M5-ARTIFACT-CACHE-ACQUISITION-AUDIT-001` fixes the next narrow boundary: explicit verified
manifest/host/cache-root inputs; unavailable/compatibility short circuits; a source-qualified leased
ready result from a warm hit without download; and exactly one accepted cold-population call on a
verified miss. Final identity and cancellation are checked before exposure, with lease release on
failure. A real Linux/Windows cold→warm client-offline integration must fetch exactly once. Manifest
loading, Electron/startup, proxy policy, SSH, settings, fallback classification, tuple enablement,
publication, and defaults remain absent.
`E-M5-ARTIFACT-ACQUISITION-LOCAL-RED-001` records the expected two-suite missing-module failure for
nine purpose cases plus real Linux/Windows cold→warm client-offline integration before
implementation.
`E-M5-ARTIFACT-ACQUISITION-LOCAL-001` is green: 11/11 purpose/integration and 18/18 focused+
workflow-oracle tests pass; 350/350 non-full-size relay and 280/280 release-script tests plus
typecheck, lint, format, diff, and protected-resolver gates pass. Real Linux tar/Brotli and Windows
ZIP paths perform exactly one verified cold fetch, release the lease, then acquire warm while the
next client fetch is configured offline. Ready results are source-qualified and leased; identity,
cancellation, and all lower-layer errors fail closed without classification. The package remains
disconnected from manifest loading, Electron/startup, proxy policy, SSH, settings, fallback, tuple
enablement, publication, and defaults. Exact-head all-six native proof is recorded immediately below.
`E-M5-ARTIFACT-ACQUISITION-CI-001` closes acquisition commit `c170ff92c`: all six primary native
Node 24 jobs, both Linux supplements, Windows x64 baseline, PR Checks, Golden E2E, and computer-use
pass. Windows arm64 retains only the declared hosted build-26200 rejection against required 26100
after full runtime smoke. Every native contract command proves real Linux/Windows cold→warm client-
offline acquisition, and every full-size extraction/cache lifecycle remains inside its latency and
memory budgets. Live GitHub/CDN/proxy/certificate behavior, manifest/startup adaptation, SSH,
settings, fallback, tuple enablement, publication, and defaults remain open; legacy remains the sole
production path.
`E-M5-LIBC-DETECTION-AUDIT-001` fixes the next smallest package: one disconnected POSIX-shell,
no-Node Linux libc probe. Only complete Orca-marked `getconf GNU_LIBC_VERSION`, `ldd --version`, or
known musl-loader segments count; unmarked startup noise, incomplete/duplicate/malformed segments,
and ambiguous/conflicting candidates return unknown. Ordinary unavailable probes remain
compatibility evidence, while cancellation propagates. Kernel/libstdc++/GLIBCXX and macOS/Windows
host-evidence composition, Electron/startup, live SSH, transfer/install, settings, fallback, tuple
enablement, publication, and defaults stay absent.
`E-M5-LIBC-DETECTION-LOCAL-RED-001` records the expected one-suite/zero-test missing-module failure
before implementation; its initial 12-case contract fixes marked glibc/musl sources, noise and
malformed/duplicate/conflict rejection, unavailable-command classification, cancellation
propagation, one 15-second exec, and exact no-Node command construction. Three bounded/concatenated-
noise cases are implementation-review hardening recorded only by the later green evidence.
`E-M5-LIBC-DETECTION-LOCAL-001` passes 15/15 purpose, 46/46 focused+workflow, 365/365 non-full-size
relay, 280/280 release-script, typecheck, lint, format, reliability, max-lines, localization, diff,
and protected-resolver gates. One 15-second cancellable POSIX command prefers marked getconf,
accepts exact marked glibc/musl ldd or known-loader evidence, bounds parsed segments/lines, returns
unknown for missing/malformed/oversized/ambiguous/conflicting evidence, and propagates cancellation.
The purpose suite now runs in both native workflow families. This remains unit/contract evidence,
not live SSH or GNU/BusyBox/Alpine proof; full host composition and every production/default path
remain absent. Exact-head all-six native proof is next.
`E-M5-LIBC-DETECTION-CI-001` closes implementation commit `d8b17a354`: all six primary native Node
24 jobs, both Linux supplements, Windows x64 baseline, PR Checks, Golden E2E, and computer-use pass.
Every POSIX client passes 79 files / 532 tests and every Windows client passes 80 files / 523 tests
with 13 declared skips, including the new 15-case libc suite. Full-size extraction/cache metrics stay
inside budget. Windows arm64 completes exact-byte PTY/watcher smoke, then retains only the declared
hosted build-26200 rejection against required 26100; this is the aggregate workflow's sole failure.
Real SSH/distro behavior, remaining host evidence, composition, and every production/default path
remain open; legacy remains the sole production path.
`E-M5-LINUX-KERNEL-DETECTION-AUDIT-001` fixes the next narrow boundary: one disconnected,
15-second cancellable POSIX-shell/no-Node marked `uname -r` probe plus a kernel-only numeric-prefix
parser. Common supported Rocky/RHEL releases such as `4.18.0-553.5.1.el8_10.x86_64` currently fail
the generic parser because its suffix grammar excludes `_`; the kernel parser will admit only the
bounded distro suffix alphabet `[0-9A-Za-z._+~-]` without relaxing libc, macOS, or Windows version
parsing. Missing, noisy, incomplete, duplicate, malformed, oversized, or invalid evidence returns
unknown; ordinary probe failure remains availability evidence and cancellation propagates. The
reviewed 4.18 floor is unchanged. Host-evidence composition, product callers, live SSH/distro
proof, transfer/install, settings, fallback, tuple enablement, publication, and defaults stay
absent; legacy remains the sole production path.
`E-M5-LINUX-KERNEL-DETECTION-LOCAL-RED-001` records the expected two-file failure before
implementation: the purpose suite collects zero tests because its detection module is absent, and
the existing selector passes 24 cases but fails three Rocky/RHEL assertions. Supported and
below-floor `el8_10` releases both return `unknown-kernel`, proving the underscore suffix gap. Exact
Node 24 and all-six native execution remain required after local green.
`E-M5-LINUX-KERNEL-DETECTION-LOCAL-001` is green: 19/19 purpose tests, 60/60 focused+workflow tests,
394/394 non-full-size relay tests with three declared skips, 280/280 release-script tests, typecheck,
lint, format, reliability, max-lines, localization, diff, and protected-resolver gates pass. One
15-second cancellable marked POSIX command returns only a unique strict `uname -r`; supported
Rocky/RHEL, Ubuntu, and Alpine suffixes select against the unchanged 4.18 floor, while malformed,
oversized, noisy, unavailable, or invalid evidence returns unknown and cancellation propagates.
Libc, macOS, and PowerShell grammars remain strict. This is contract evidence, not live SSH/distro
proof; full host composition and every production/default path remain absent. Exact-head all-six
native proof is next.
`E-M5-LINUX-KERNEL-DETECTION-CI-001` closes implementation commit `d1eb0eb63`: all six primary
native Node 24 jobs, both Linux supplements, Windows x64 baseline, PR Checks, Golden E2E, and
computer-use pass. Every POSIX client passes 80 files / 561 tests and every Windows client passes 81
files / 552 tests with 13 declared skips, including the new 19-case kernel suite and strict selector
cases. Full-size extraction/cache metrics stay inside budget. Windows arm64 completes exact-byte
Node/PTY/watcher smoke, then retains only the declared hosted build-26200 rejection against required
26100; this is the aggregate workflow's sole failure. Real SSH/distro behavior, remaining host
evidence, composition, and every production/default path remain open; legacy remains the sole
production path.
`E-M5-DARWIN-VERSION-DETECTION-AUDIT-001` fixes the next smallest package: one disconnected,
15-second cancellable POSIX-shell/no-Node marked `sw_vers -productVersion` probe. Only one complete
strict two-to-four-component numeric version counts; missing, noisy, incomplete, duplicate,
malformed, suffixed, or oversized evidence returns unknown and cancellation propagates. The
reviewed macOS 13.5 floor and selector grammar stay unchanged. Rosetta/process translation, Linux
libstdc++/GLIBCXX, Windows evidence, full host composition, product callers, live SSH, transfer/
install, settings, fallback, tuple enablement, publication, and defaults remain absent.
`E-M5-DARWIN-VERSION-DETECTION-LOCAL-RED-001` records the expected missing-module failure before
implementation: the purpose suite has one failed file and zero collected tests because the audited
detection module does not exist. The native-workflow oracle now also requires that purpose suite
exactly once in both POSIX and PowerShell runner commands and remains red until they are wired.
Protected resolver files have zero diff; no production caller or default behavior is connected.
`E-M5-DARWIN-VERSION-DETECTION-LOCAL-001` is green: 21/21 purpose tests, 62/62 focused+workflow
tests, 415/415 non-full-size relay tests with three declared skips, 280/280 release-script tests,
typecheck, lint, format, max-lines, diff, and protected-resolver gates pass. One 15-second
cancellable marked POSIX command returns only a unique bounded numeric `sw_vers -productVersion`;
malformed, noisy, duplicate, unavailable, or oversized evidence returns unknown and cancellation
propagates. Both native runner families require the suite. Exact Node 24/all-six native proof is
next; real SSH/macOS, Rosetta, composition, and all production/default behavior remain absent.
`E-M5-DARWIN-VERSION-DETECTION-CI-001` closes implementation commit `bcda04389`: all six primary
native Node 24 jobs, both Linux supplements, Windows x64 baseline, PR Checks, Golden E2E, and
computer-use pass. Every native client runs the 21-case purpose suite; POSIX jobs pass 81 files /
582 tests and Windows jobs pass 82 files / 573 tests with 13 declared skips. Windows arm64 verifies
the complete 85,213,511-byte runtime plus Node/PTY/watcher/resource settlement and retains only the
known hosted build-26200 rejection against required 26100. This is contract evidence, not live SSH/
macOS or Rosetta proof; composition and every production/default path remain absent.
`E-M5-DARWIN-TRANSLATION-DETECTION-AUDIT-001` fixes the next smallest package: one disconnected,
15-second cancellable POSIX-shell/no-Node marked probe of `sysctl.proc_translated` plus
`hw.optional.arm64`. Explicit non-conflicting 1/0 values return translated/native; a missing
translation key with explicit non-arm64 hardware proves native Intel; missing/conflicting/
malformed evidence remains unknown. The detector does not change selector types or compose an
unknown into a boolean. Live Rosetta SSH remains a separate required cell; product callers,
transfer/install, settings, fallback wiring, tuple enablement, publication, and defaults stay
absent.
`E-M5-DARWIN-TRANSLATION-DETECTION-LOCAL-RED-001` records the expected missing-module failure and
the native-workflow oracle's 6/7 result before implementation. Neither runner command contains the
new suite, so its source occurrence count is one instead of three. Protected resolver files remain
untouched; no selector, composer, caller, or default behavior is connected.
`E-M5-DARWIN-TRANSLATION-DETECTION-LOCAL-001` is green: 23/23 purpose tests, 85/85 focused+workflow
tests, 438/438 non-full-size relay tests with three declared skips, 280/280 release-script tests,
typecheck, lint, format, max-lines, diff, and protected-resolver gates pass. Explicit
non-conflicting Darwin sysctl evidence returns translated/native; Intel absent-key evidence is
handled without coercing arm64-capable or unknown probe loss to native. Both native workflow
families require the suite. Exact Node 24/all-six native proof is next; live Rosetta SSH,
composition, and all production/default behavior remain absent.
`E-M5-DARWIN-TRANSLATION-DETECTION-CI-001` closes implementation commit `c8d4acb2c`: all six
primary native Node 24 jobs, both Linux supplements, Windows x64 baseline, PR Checks, Golden E2E,
and computer-use pass. POSIX clients pass 82 files / 605 tests and Windows clients pass 83 files /
596 tests with 13 declared skips, including the 23-case purpose suite. Windows arm64 verifies the
complete 85,213,511-byte runtime plus Node/PTY/watcher/resource settlement and retains only the
declared hosted build-26200 rejection against required 26100. This is contract evidence, not live
SSH/Intel/Rosetta proof; composition and every production/default path remain absent.
`E-M5-LINUX-LIBSTDCXX-DETECTION-AUDIT-001` fixes the next smallest package: one disconnected,
15-second cancellable marked Linux loader-cache probe using `ldconfig`, `readlink -f`, and bounded
binary-safe `grep -ao`. It does not require `strings`, which is absent from the audited minimal
Ubuntu image. Only complete, bounded, consistent physical libstdc++ and maximum GLIBCXX evidence
counts; loader overrides, missing tools, malformed/duplicate/overflow evidence, and conflicting
multilib candidates return unknown. Host composition, product callers, transfer/install, settings,
fallback, tuple enablement, publication, and defaults stay absent.
`E-M5-LINUX-LIBSTDCXX-DETECTION-LOCAL-RED-001` records the expected missing-module failure and the
native-workflow oracle's 6/7 result. Neither runner family contains the new suite yet; no product
caller or default behavior is connected.
`E-M5-LINUX-LIBSTDCXX-DETECTION-LOCAL-001` is green: 23/23 purpose tests, 142/142 focused+workflow
tests, 461/461 broader relay tests with three declared skips, 280/280 release-script tests,
typecheck, lint, format, max-lines, diff, and protected-resolver gates pass. The single bounded probe
refuses loader overrides, requires strict consistent loader-cache/physical-file/GLIBCXX evidence,
and has exact POSIX syntax proof without `strings` or a runtime dependency. Both native workflow
families require the suite. Exact Node 24/all-six native proof is next; host composition, live SSH,
and every production/default path remain absent.
`E-M5-LINUX-LIBSTDCXX-DETECTION-CI-RED-001` records exact-head run `29487742612`: the native Darwin
x64 job passes the new 23-case detector suite, then two dependency-injected cache unit suites collect
zero cases because their transitive Electron import attempts an uninstalled-binary network fetch.
The job exits with two failed / 81 passed files and 612 passed tests. This is a client-offline test
isolation defect; rerun-until-green is rejected. Add only purpose-scoped Electron mocks to those two
unit suites, retain real downloader/integration coverage, and repeat all-six native CI. Production
code, host composition, SSH, settings, fallback, tuple enablement, and defaults remain unchanged.
`E-M5-LINUX-LIBSTDCXX-DETECTION-CLIENT-OFFLINE-CORRECTION-LOCAL-001` is green: the two
dependency-injected cache suites now mock Electron and assert `net.fetch` is never called. Focused
proof passes 46/46, broader relay proof passes 461/461 with three declared skips, release scripts
pass 280/280, and typecheck, lint, format, max-lines, diff, and protected-resolver gates pass.
Production code remains unchanged. Replacement exact Node 24/all-six native CI is next.
`E-M5-LINUX-LIBSTDCXX-DETECTION-CI-001` closes exact head `1182bcdc5`: all six primary native Node
24 jobs, both Linux supplements, Windows x64 baseline, PR Checks, Golden E2E, and computer-use pass.
POSIX clients pass 83 files / 628 tests and Windows clients pass 84 files / 618 tests with 14
declared skips. Windows arm64 completes 60-entry/42-file/85,213,511-byte tree, Node/PTY/watcher/
resource proof and retains only the declared hosted build-26200 rejection against required 26100.
Full-size extraction/cache metrics stay inside budget. This is not live SSH/remote evidence; the
detector stays disconnected, every tuple stays disabled, and legacy remains the sole default.
`E-M5-WINDOWS-COMPATIBILITY-DETECTION-AUDIT-001` fixes the next smallest package: one disconnected,
15-second cancellable encoded Windows PowerShell probe for the already-reviewed OS build, OpenSSH
for Windows, Windows PowerShell, and .NET Framework selector fields. Only one complete, bounded,
strict four-field segment counts; missing tools/registry data, malformed/duplicate/unknown/overflow
evidence, or ordinary command failure returns unknown, while cancellation propagates. Native
Windows syntax/execution and both workflow families are required. Host composition, live SSH,
transfer capability, settings, fallback, tuple enablement, publication, and defaults stay absent.
`E-M5-WINDOWS-COMPATIBILITY-DETECTION-RED-001` proves both gates fail before implementation at head
`6209151dd`: the purpose suite cannot import the absent detector (zero collected tests), while the
workflow oracle passes 6/7 and rejects the suite's single native-family occurrence against the two
required occurrences. No production caller or protected-resolver diff exists at the RED gate.
`E-M5-WINDOWS-COMPATIBILITY-DETECTION-LOCAL-001` is locally green: 26 purpose cases pass with the
native-Windows execution case declared skipped on macOS; 168/168 focused cases, 487/487 broader
relay cases, and 280/280 release-script cases pass. Typecheck, full lint, reliability, max-lines,
localization, format, diff, and protected-resolver gates pass. The module remains disconnected;
native Windows execution and all-six Node 24 proof are the next gate, while live SSH, composition,
settings, fallback wiring, tuple enablement, publication, defaults, and SignPath remain absent.
`E-M5-WINDOWS-COMPATIBILITY-DETECTION-CI-RED-001` records the first native x64 gate at exact head
`30bf908f2`: 84 files/644 tests pass, including every detector parser/command case, and only the
native execution assertion fails. The encoded probe exits 0 with the exact bounded stdout; hosted
Windows adds bounded first-use progress CLIXML on stderr. The narrow correction accepts only empty
stderr or that bounded progress shape with no error record; production code remains unchanged.
`E-M5-WINDOWS-COMPATIBILITY-DETECTION-CORRECTION-LOCAL-001` passes 31 purpose cases plus the seven-
case workflow oracle, with only native execution skipped on macOS. Five explicit cases accept empty/
bounded-known progress and reject unknown, error, or oversized stderr. Typecheck, targeted lint/
format, max-lines, diff, and protected-resolver gates pass; replacement native CI is mandatory.
`E-M5-WINDOWS-COMPATIBILITY-DETECTION-CI-001` closes exact head `c489ee9f7`: all six primary native
clients, both Linux supplements, Windows x64 baseline, PR Checks, Golden E2E, and computer-use pass.
Both Windows architectures pass all 32 detector cases under native Windows PowerShell. Windows
arm64 completes full runtime proof and retains only the declared hosted build-26200 rejection against 26100. No live SSH, composer, product caller, setting/fallback, tuple, publication, or default exists.
`E-M5-HOST-EVIDENCE-COMPOSITION-AUDIT-001` fixes the next disconnected boundary: consume an explicit
canonical detected platform, SSH connection, and signal; run only that OS family's already-proven
detectors with at most three concurrent bounded channels; and return frozen selector-shaped evidence.
Darwin translation unknown returns no evidence rather than inventing native/translated state.
Inconsistent platform identity, product/startup callers, selector changes, live SSH, settings,
fallback, transfer/install, tuple enablement, publication, defaults, and SignPath stay absent.
RED is recorded before implementation: the purpose suite exits 1 because its module is absent
(0 tests, 316 ms, 132,235,264-byte max RSS), and the workflow oracle exits 1 because the suite has
only its POSIX native-family occurrence (6 passed/1 failed, 409 ms, 131,743,744-byte max RSS).
Pre-RED diff and protected-resolver checks pass.
`E-M5-HOST-EVIDENCE-COMPOSITION-LOCAL-001` is green: 20/20 purpose and 193/193 focused assertions,
512/512 broader relay assertions, 280/280 release-script assertions, typecheck, lint, format,
max-lines, diff, no-product-import, and protected-resolver gates pass. The disconnected composer
validates canonical platform identity before probes; invokes only Linux's three, Darwin's two, or
Windows' one accepted bounded detector; runs multi-probe families concurrently; preserves
conservative unknowns; refuses unknown Darwin translation; propagates cancellation/errors; and
deeply freezes evidence. It is required in both native workflow families. Exact-head all-six Node 24
client proof remains mandatory; no live SSH, product caller, settings/fallback, transfer/install,
tuple, publication, default, or SignPath work is included.
`E-M5-HOST-EVIDENCE-COMPOSITION-CI-001` closes exact implementation head `a7fd19de5`: all six
primary native Node 24 clients pass the 20-case composer suite, both Linux supplements and Windows
x64 baseline pass, and PR Checks, Golden E2E, and computer-use pass. Windows arm64 completes full
tree/Node/PTY/watcher/resource proof and retains only the declared hosted build-26200 rejection
against required build 26100. Full-size extraction/cache metrics remain within their existing
budgets. This is native client composition evidence, not live SSH; no product caller, transfer,
settings/fallback, tuple, publication, default, or SignPath behavior exists.
`E-M5-ARTIFACT-CACHE-ROOT-CI-001` closes the pure cache-root contract at exact head `aefcaa9a9`:
all six primary native Node 24 jobs, both Linux supplements, Windows x64 baseline, PR Checks, Golden
E2E, and computer-use pass; Windows arm64 build 26200 remains correctly gated against 26100. The
startup-boundary audit found that a late direct `app.getPath('userData')` adapter would be unsafe
because `app.setName()` can change that path. The eventual startup caller must supply Orca's
pre-`app.setName()` canonical path. The next slice may only compose explicit resolver/cache
dependencies; it must add no proxy, SSH/Beta mode/tuple/publication/default behavior.
`E-M5-ARTIFACT-CACHE-ROOT-LOCAL-001` passes 3/3 purpose tests, the native
workflow oracle, 314/314 non-full-size SSH relay tests, 280/280 release-script tests, typecheck,
lint, format, reliability, max-lines, localization, and diff gates. Both POSIX and PowerShell native
artifact commands now run the purpose suite. The pure function accepts only an absolute
caller-supplied native user-data path and returns a fixed `ssh-relay-runtime-cache/v1` namespace;
an environment variable cannot redirect it. No Electron caller, filesystem I/O, cache operation,
downloader, SSH/Beta mode/tuple/publication/default behavior exists.
`E-M5-OFFICIAL-MANIFEST-COMPOSITION-CI-001` closes the official-manifest composition at exact head
`749f775f1`: all six primary native jobs, both Linux supplements, Windows x64 baseline, PR Checks,
Golden E2E, and computer-use pass; Windows arm64 build 26200 remains correctly gated against 26100.
The next slice may derive only a pure fixed cache root from an absolute caller-supplied native
user-data path; it must add no Electron caller, filesystem I/O, cache orchestration, environment
override, downloader/SSH/Beta mode/tuple/publication/default behavior.
`E-M5-OFFICIAL-MANIFEST-COMPOSITION-LOCAL-001` passes 4/4 focused, 26/26
trust, 311/311 non-full-size SSH relay, 280/280 release-script, workflow-oracle, typecheck, lint,
format, max-lines, and diff gates. An unprovisioned build returns unavailable before resource access;
provisioned trust is the only accepted-key source and binds the verified fixed-resource manifest to
its canonical key fingerprint. No resource or product consumer exists. `E-M5-COMPILED-TRUST-CI-001`
closes the prior compiled trust and stream-settlement checkpoint at exact
head `bb7493614`: all six primary native artifact jobs, both Linux supplements, Windows x64
baseline, PR Checks, Golden E2E, and unchanged computer-use retry pass. The artifact workflow is
red only because hosted Windows arm64 build 26200 correctly fails the required 26100 floor. The
next slice may compose immutable trust with the fixed-resource loader, but must add no resource,
production key/manifest, Electron/product consumer, cache/downloader, SSH, Beta mode, tuple,
publication, or default behavior. `E-M5-COMPILED-TRUST-AUDIT-001` and its RED precede
`E-M5-COMPILED-TRUST-LOCAL-001`: 3/3 focused, 22/22 trust, 307/307 non-full-size SSH relay, 279/279
release-script, workflow-oracle, typecheck, lint, format, max-lines, and diff gates pass. The build
constant is literal `null`; no production key file, resource bytes, or consumer exists. Superseded
artifact run 29470322099 exposed an unawaited
draft-upload request-stream lifecycle (`E-M5-COMPILED-TRUST-CI-RED-001`), now deterministically
reproduced and locally corrected with 9/9 focused and 280/280 release-script tests under
`E-M5-DRAFT-UPLOAD-STREAM-SETTLEMENT-LOCAL-001`. Windows x64 job 87532052082 independently failed an
existing cache-lock concurrency test with `EPERM` plus teardown `ENOENT`
(`E-M5-COMPILED-TRUST-WINDOWS-CI-RED-001`); neither failure repeated at the accepted replacement
head. Real Apple/SignPath work remains deferred to its late gate. Prior exact
head `11f367e66` passes all six primary native accepted-key jobs under
`E-M5-ACCEPTED-KEYS-CI-001` and Golden E2E; the artifact workflow is red only for the retained
Windows arm64 hosted build-26200 versus required-26100 floor gap. PR Checks attempt 1 failed one
renderer PTY ownership race in untouched code after 30,100 passes; attempt 2 has passed the complete
job, including tests, unpacked build, and packaged CLI smoke. Real Apple/SignPath rehearsal remains
a late explicit gate. The prior `E-M5-PACKAGED-MANIFEST-LOCAL-001` passes 6/6
purpose-named tests, 300/300 non-full-size SSH relay tests, 279/279 release-script tests, typecheck,
lint, format, max-lines, and diff gates. `E-M5-PACKAGED-MANIFEST-CI-WIRING-LOCAL-001` pins the suite
into both native job families; exact-head run
[29466359518](https://github.com/stablyai/orca/actions/runs/29466359518) passes the contract step and
complete primary job on Linux, macOS, and Windows, x64 and arm64, under
`E-M5-PACKAGED-MANIFEST-CI-001`. PR Checks
[29466359581](https://github.com/stablyai/orca/actions/runs/29466359581) and Golden E2E
[29466359541](https://github.com/stablyai/orca/actions/runs/29466359541) pass. No packaged resource,
production key, cache root, downloader, SSH consumer, Beta mode, tuple, publication, or default
behavior is connected. Prior exact-head run
[29464742446](https://github.com/stablyai/orca/actions/runs/29464742446) passes the lease/eviction
source contracts and exact full-size active-retention/release/eviction lifecycle on Linux, macOS,
and Windows, x64 and arm64, under `E-M5-ARTIFACT-CACHE-EVICTION-CI-001`. Retention is 11.14–47.88ms
and 0–1.99 MiB incremental RSS; eviction is 19.02–92.90ms and 0–2.08 MiB, reclaiming each exact
118.4–161.3 MB entry. PR Checks
[29464742361](https://github.com/stablyai/orca/actions/runs/29464742361) and Golden E2E
[29464742368](https://github.com/stablyai/orca/actions/runs/29464742368) pass. Prior exact-head
run [29462394311](https://github.com/stablyai/orca/actions/runs/29462394311) passes all 17 cache-entry
contracts and exact full-size cold/warm measurements on Linux, macOS, and Windows, x64 and arm64,
under `E-M5-ARTIFACT-CACHE-ENTRY-CI-001`. Cold publication is 1.17–6.17s and 34.5–48.8 MiB
incremental RSS; warm verified lookup is 0.12–0.70s and 0–6.9 MiB. PR Checks
[29462394310](https://github.com/stablyai/orca/actions/runs/29462394310) and Golden E2E
[29462394344](https://github.com/stablyai/orca/actions/runs/29462394344) pass. Windows arm64 retains
only the declared hosted build-26200 versus required-26100 floor gap after its primary runtime/cache
proof. Desktop consumers, SSH transfer/install, mode wiring, tuple enablement, publication,
production keys/environment/seed, and merge to `main` remain disconnected.

## Safety status

- [x] Existing SSH relay installation remains the default for every target.
- [x] The future bundled runtime is a per-target Beta option, off by default.
- [x] Missing, old, imported, unknown, or malformed settings select legacy behavior.
- [x] No bundled tuple is enabled and no runtime artifact is published.
- [x] Integrity, security, and corruption failures are designed to fail closed, not fall back.
- [x] Legacy removal or a default-on change requires a separate reviewed decision.

## Current gates

- [ ] **WP2 external gate — Prove oldest supported baselines and native trust.**
  - Proven: all-six target-native build/equality/smoke/metadata gates and direct payload audit.
  - Proven: exact-head run
    [29379227209](https://github.com/stablyai/orca/actions/runs/29379227209) builds both Linux tuples in
    digest-pinned Rocky 8 on native runners; both downloaded artifacts pass glibc 2.28/libstdc++
    6.0.25 execution, bundled Node, PTY, and watcher smoke.
  - Windows x64 passes its declared oldest-floor job. The hosted arm64 runner is build 26200, not the
    required build 26100, so its otherwise successful artifact/runtime smoke does not close that cell.
  - Proven: native-signing plan commit `9bdae7f5b` and CI correction `9c0357235` pass locally and on
    all six native jobs in exact-head run
    [29381495240](https://github.com/stablyai/orca/actions/runs/29381495240).
  - Proven locally and in exact-head run
    [29382772805](https://github.com/stablyai/orca/actions/runs/29382772805): credential-free exact
    signing selection, exclusive staging, returned-tree verification, and POSIX/Windows CI wiring.
  - Proven locally and in exact-head run
    [29384042509](https://github.com/stablyai/orca/actions/runs/29384042509): target-native pre-sign
    assessment and real first-build candidate staging without credentials.
  - Proven locally and in exact-head run
    [29385274738](https://github.com/stablyai/orca/actions/runs/29385274738): exact returned-file
    application into a fresh full runtime and final post-sign content identity contracts.
  - Proven locally and in exact-head run
    [29386372366](https://github.com/stablyai/orca/actions/runs/29386372366): final-tree-first,
    bounded strict-codesign and exact Node/Orca Developer ID policy contracts run under Node 24 on
    all six native jobs. This is contract proof, not proof of real Orca signatures or native trust.
  - Proven locally and in exact-head run
    [29387668264](https://github.com/stablyai/orca/actions/runs/29387668264): credential-free Windows
    final-tree-first Authenticode policy contracts execute under Node 24 on all six native jobs.
    This is contract proof, not proof of real SignPath returns or native trust.
  - Proven locally and on native x64/arm64 Windows jobs in exact-head run
    [29388734922](https://github.com/stablyai/orca/actions/runs/29388734922): official Node and both
    preserved Microsoft ConPTY files report `Valid`; downloaded reports match the exact identity,
    hashes, subjects, thumbprints, and signing-stage selection
    (`E-M3-WINDOWS-SOURCE-SIGNATURE-CI-001`). PR Checks
    [29388734935](https://github.com/stablyai/orca/actions/runs/29388734935) and Golden E2E
    [29388734914](https://github.com/stablyai/orca/actions/runs/29388734914) are green at `be32653a7`.
    The artifact workflow remains red only for the declared Windows arm64 floor mismatch (hosted
    build 26200 versus required 26100). Real SignPath returns and missing oldest-floor snapshots
    remain separately gated.
  - Next external proof: kernel 4.18, macOS 13.5, Windows arm64 build 26100, and native signing/trust.
  - No tuple is enabled; every SSH transfer/runtime and rollout cell remains open.
- [ ] **WP3 active implementation — disconnected native signing workflow locally proven.**
      Windows compatibility-kind parity is closed locally and on all six target-native jobs in
      exact-head run
      [29393022768](https://github.com/stablyai/orca/actions/runs/29393022768) under
      `E-M4-WINDOWS-MANIFEST-PARITY-LOCAL-001` and `E-M4-WINDOWS-MANIFEST-PARITY-CI-001`.
      Disconnected canonical assembly and signing-handoff modules are closed locally and on all six
      Node 24 native jobs in exact-head run
      [29395319239](https://github.com/stablyai/orca/actions/runs/29395319239) under
      `E-M4-MANIFEST-HANDOFF-CI-001`. The disconnected credential-free aggregate boundary is closed
      locally and on all six Node 24 native jobs in exact-head run
      [29397871159](https://github.com/stablyai/orca/actions/runs/29397871159) under
      `E-M4-MANIFEST-AGGREGATE-LOCAL-001`, `E-M4-MANIFEST-AGGREGATE-LOCAL-002`, and
      `E-M4-MANIFEST-AGGREGATE-CI-001`. Next, produce the exact post-sign tuple descriptor only from
      a fully verified returned runtime tree and bind it to the archive, SBOM, provenance, native
      assessment, and content identity under credential-free fail-closed tests. No production
      workflow, publication, desktop consumer, signing credential, or tuple is connected. The
      purpose-named missing-module RED is recorded under
      `E-M4-MANIFEST-TUPLE-LOCAL-RED-001`. The first implementation run exposed that both manifest
      validators incorrectly require one node-pty native file for Windows even though the proven
      closure contains `conpty.node` and `conpty_console_list.node`; correct and parity-test the exact
      per-platform role counts first (`E-M4-MANIFEST-TUPLE-SCHEMA-RED-001`). The correction,
      credential-free producer, 228-test release suite, 48-test desktop parity suite, and static gates
      are locally green under `E-M4-MANIFEST-TUPLE-LOCAL-001` and
      `E-M4-MANIFEST-TUPLE-LOCAL-002`. Exact-head run
      [29405619251](https://github.com/stablyai/orca/actions/runs/29405619251) passes the new seven-test
      tuple suite and full runtime construction on all six Node 24 native jobs under
      `E-M4-MANIFEST-TUPLE-CI-001`; PR Checks
      [29405619196](https://github.com/stablyai/orca/actions/runs/29405619196) and Golden E2E
      [29405619242](https://github.com/stablyai/orca/actions/runs/29405619242) are green. The artifact
      run is red only for the declared Windows arm64 floor mismatch (hosted build 26200 versus
      required 26100). Next, regenerate and semantically verify post-sign SBOM/provenance from the
      verified final tree. That implementation is locally green, but exact-head run
      [29408355188](https://github.com/stablyai/orca/actions/runs/29408355188) exposed a Windows x64
      test-fixture portability defect: the hardcoded Linux tar fixture cannot obtain its declared
      executable mode from a Windows filesystem, so strict archive inspection correctly rejects
      `bin/node` (`E-M4-POST-SIGN-METADATA-CI-RED-001`). The platform-native fixture correction is
      locally green across the 22-test focused suite, 233-test release suite, 48-test desktop parity
      suite, typecheck, and full lint without weakening production mode validation
      (`E-M4-POST-SIGN-METADATA-CORRECTION-LOCAL-001`). Replacement all-six exact-head evidence is
      complete in run
      [29409257513](https://github.com/stablyai/orca/actions/runs/29409257513): all six native build
      jobs pass the corrected four-test metadata suite and full artifact construction under
      `E-M4-POST-SIGN-METADATA-CI-001`. PR Checks
      [29409257568](https://github.com/stablyai/orca/actions/runs/29409257568) and Golden E2E
      [29409257636](https://github.com/stablyai/orca/actions/runs/29409257636) are green. The artifact
      run is red only for the separately declared Windows arm64 floor mismatch. The reusable native
      build prerequisite is closed locally and on all six build jobs under
      `E-M4-BUILD-PREREQUISITE-CI-001`. The next disconnected package reconstructs authenticated
      unsigned archives, signs only the exact native payload, applies returned bytes into an
      exclusive full tree, verifies native policy before PTY/watcher smoke, and regenerates the final
      archive, SBOM, provenance, and tuple descriptor. Its purpose-named RED and locally green
      implementation are recorded under `E-M4-NATIVE-SIGNING-WORKFLOW-LOCAL-RED-001` and
      `E-M4-NATIVE-SIGNING-WORKFLOW-LOCAL-001`. Exact-head native schema/contract execution is closed
      under `E-M4-NATIVE-SIGNING-WORKFLOW-CI-001`; real Apple/SignPath returned-byte/native-trust
      rehearsals remain open. Release-cut, publication, desktop consumers, and every tuple remain
      disconnected. Merging to `main` remains prohibited.

## Work packages, in required order

### WP0 — Existing Node/npm resolver correction

- [x] Implement and unit-test coherent remote Node/npm selection.
- [x] Prove live Linux arm64 SSH/PTY behavior.
- [x] Keep the fix independently reviewable from runtime distribution.
- [ ] Merge draft PR [#8724](https://github.com/stablyai/orca/pull/8724).

### WP1 — Contracts only

- [x] Define immutable signed manifests, content identity, exact asset URLs, and conservative tuple
      selection.
- [x] Add hostile manifest, schema, signature, and path tests.
- [ ] Finish archive-safety implementation and hostile archive tests.
- [ ] Update mode-qualified remote directory parsing and GC compatibility.
- [ ] Merge draft PR [#8728](https://github.com/stablyai/orca/pull/8728).

### WP2 — Target-native runtime artifacts

- [x] Pin and verify Node v24.18.0 inputs and signatures.
- [x] Build and smoke-test Node, patched `node-pty`, and `@parcel/watcher` on GitHub runners for
      Linux, macOS, and Windows on x64 and arm64.
- [x] Prove exact clean-build equality and exact runtime-tree closure on all six runner families.
- [x] Replace unpublished POSIX `.tar.xz` outputs with deterministic bounded `.tar.br` and rerun
      exact clean-build/archive/execution proof on all six native jobs
      (`E-M5-ARCHIVE-PORTABILITY-AUDIT-001` selects the correction;
      `E-M5-PORTABLE-ARCHIVE-LOCAL-RED-001` proves the old boundary fails;
      `E-M5-PORTABLE-ARCHIVE-LOCAL-001`, `E-M5-PORTABLE-ARCHIVE-PARENT-LOCAL-001`, and
      `E-M5-PORTABLE-ARCHIVE-CI-001`).
- [x] Complete the all-six SBOM, license, provenance, toolchain, and prohibited-content audit.
- [x] Rebuild both Linux artifacts in the digest-pinned glibc 2.28/libstdc++ 6.0.25 userland on
      native x64/arm64 runners; smoke and compare them there. (`E-M3-LINUX-NATIVE-USERLAND-CI-001`)
- [ ] Prove each candidate on its oldest supported OS/libc/kernel baseline.
- [ ] Sign macOS and Windows bytes and verify native trust on the target OS.
- [ ] Merge draft PR [#8741](https://github.com/stablyai/orca/pull/8741).

### WP3 — Release build and signing

- [x] Release/signing DAG contracts pass locally and on all six native build jobs under
      `E-M4-RELEASE-DAG-LOCAL-001` and `E-M4-RELEASE-DAG-CI-001`.
- [x] Aggregate-input and authenticated draft read-back verification pass locally and on all six
      native build jobs under `E-M4-AGGREGATE-READBACK-LOCAL-001` and
      `E-M4-AGGREGATE-READBACK-CI-001`.
- [x] Correct the Windows compatibility discriminator and `bin/node.exe` manifest parity; prove both
      regenerated Windows identities and all-six native regressions
      (`E-M4-WINDOWS-MANIFEST-PARITY-LOCAL-001`, `E-M4-WINDOWS-MANIFEST-PARITY-CI-001`).
- [x] Add disconnected canonical unsigned
      manifest assembly, a bounded signing request, and returned-signature verification. Keep final
      detached-signature asset encoding, production credentials, publication, desktop consumers, and
      every tuple outside this slice until their contracts and gates are explicit. Purpose-named RED
      and GREEN suites plus broad local regressions are recorded under
      `E-M4-MANIFEST-HANDOFF-LOCAL-RED-001`, `E-M4-MANIFEST-HANDOFF-LOCAL-001`, and
      `E-M4-MANIFEST-HANDOFF-LOCAL-002`; all-six Node 24 proof is recorded under
      `E-M4-MANIFEST-HANDOFF-CI-001`.
- [x] Add the disconnected, credential-free
      fail-closed aggregate boundary from exact verified runtime inputs through canonical request and
      verified final-manifest bytes. Keep native/manifest credentials, publication, desktop
      consumers, and every tuple outside this slice
      (`E-M4-MANIFEST-AGGREGATE-LOCAL-001`, `E-M4-MANIFEST-AGGREGATE-LOCAL-002`,
      `E-M4-MANIFEST-AGGREGATE-CI-001`).
- [x] Add the credential-free post-sign
      tuple-descriptor producer and native-verification handoff needed to supply the aggregate.
      Derive it only from a fully verified returned runtime tree; keep real signing, publication,
      desktop consumers, and every tuple outside this slice. The missing-module RED is recorded under
      `E-M4-MANIFEST-TUPLE-LOCAL-RED-001`. Before GREEN, correct release/desktop tuple-role
      cardinality for the real Windows closure under `E-M4-MANIFEST-TUPLE-SCHEMA-RED-001`. Code and
      local proof are complete under `E-M4-MANIFEST-TUPLE-LOCAL-001` and
      `E-M4-MANIFEST-TUPLE-LOCAL-002`; all-six exact-head Node 24 proof is recorded under
      `E-M4-MANIFEST-TUPLE-CI-001`.
- [x] Regenerate SBOM and provenance from
      the verified post-sign runtime tree and semantically bind both outputs to the final content
      identity before tuple assembly. Keep credentials, publication, desktop consumers, and every
      tuple disconnected. The purpose-named missing-module RED is recorded under
      `E-M4-POST-SIGN-METADATA-LOCAL-RED-001`. The implementation, semantic tuple-consumer gate,
      233-test release suite, 48-test desktop parity suite, and static gates are locally green under
      `E-M4-POST-SIGN-METADATA-LOCAL-001` and `E-M4-POST-SIGN-METADATA-LOCAL-002`; exact-head Node 24
      execution on all six native jobs is required before this item closes. Windows x64 job
      [87329210635](https://github.com/stablyai/orca/actions/runs/29408355188/job/87329210635)
      is the required CI RED: its filesystem cannot create the hardcoded Linux tar fixture's
      executable mode, and strict archive inspection rejects `bin/node`
      (`E-M4-POST-SIGN-METADATA-CI-RED-001`). The test-fixture-only correction now selects the exact
      native tuple/archive family on each runner and is locally green under
      `E-M4-POST-SIGN-METADATA-CORRECTION-LOCAL-001`; production type/mode validation is unchanged.
      Exact-head execution passes on all six native jobs under
      `E-M4-POST-SIGN-METADATA-CI-001`.
- [x] Add a reusable target-native runtime
      build prerequisite contract. Keep it disconnected from release-cut and every desktop build
      until exact floors, native signing/trust, aggregate, and publication gates are complete; no
      tuple is enabled by this slice. The purpose-named RED proves `workflow_call` was absent; the
      credential-free interface and both native test-family integrations are locally green while
      both release workflows remain disconnected (`E-M4-BUILD-PREREQUISITE-LOCAL-RED-001`,
      `E-M4-BUILD-PREREQUISITE-LOCAL-001`, `E-M4-BUILD-PREREQUISITE-CI-001`).
- [ ] **In progress — 2026-07-15, Codex implementation owner:** add platform-native signing jobs;
      hash only the returned signed bytes. Begin with a purpose-named disconnected workflow RED;
      no test double counts as real signing/native-trust evidence. The workflow, authenticated
      reconstruction, bounded signing boundary, transactional finalization, and credential-free
      regression gates are locally green (`E-M4-NATIVE-SIGNING-WORKFLOW-LOCAL-RED-001`,
      `E-M4-NATIVE-SIGNING-WORKFLOW-LOCAL-001`). Exact-head native contract proof is complete; real
      protected Apple/SignPath/native-trust evidence remains required before this item can close. First
      exact-head run
      [29415080004](https://github.com/stablyai/orca/actions/runs/29415080004) is the required Windows
      CI RED: both Windows contract jobs reject two hardcoded Darwin tar fixtures because NTFS cannot
      materialize their declared executable modes, while all four POSIX native build jobs pass and
      strict production mode validation remains unchanged (`E-M4-NATIVE-SIGNING-WORKFLOW-CI-RED-001`).
      The test-only native ZIP fixture correction at `85c70c5e9` and full 241-test release suite pass
      locally. Replacement exact-head run
      [29415642475](https://github.com/stablyai/orca/actions/runs/29415642475) at `70b3892ae` is
      complete: all six target-native jobs pass the corrected contracts and full runtime build,
      smoke, equality, and upload under `E-M4-NATIVE-SIGNING-WORKFLOW-CI-001`. Both Linux userland
      supplements and Windows x64 baseline pass. The run remains red only for the separately
      declared Windows arm64 floor mismatch (hosted build 26200 versus required 26100). Golden E2E
      and PR Checks are green at the exact head. The manual credentialed rehearsal starts with the
      missing-caller RED `E-M4-NATIVE-SIGNING-REHEARSAL-LOCAL-RED-001` and is locally green under
      `E-M4-NATIVE-SIGNING-REHEARSAL-LOCAL-001`. GitHub cannot dispatch a new workflow before it
      exists on the default branch; the exact confirmation-bound refusal is recorded under
      `E-M4-NATIVE-SIGNING-REHEARSAL-DISPATCH-BLOCKED-001`, so real signing/native trust remains
      blocked without merging. Exact-head run
      [29417449971](https://github.com/stablyai/orca/actions/runs/29417449971) passes the caller and
      default-preservation contracts plus full builds on all six native jobs under
      `E-M4-NATIVE-SIGNING-REHEARSAL-CI-001`; PR Checks and Golden E2E are green. The artifact run is
      red only for the retained Windows arm64 build-26100 floor mismatch.
- [ ] Add a fail-closed aggregate and immutable manifest-signing job.
      The missing Linux aggregate-ready prerequisite is closed by
      `E-M4-LINUX-FINALIZATION-LOCAL-RED-001`, `E-M4-LINUX-FINALIZATION-LOCAL-001`, and
      `E-M4-LINUX-FINALIZATION-CI-001`: both native Linux architectures emitted inspected,
      hash-bound descriptors/receipts. The active slice is the callable, disconnected aggregate and
      protected Ed25519-signing workflow contract. The environment/seed are not provisioned, so live
      signing remains blocked and no release, desktop, publication, or tuple consumer is connected.
      The missing-workflow/seed-signer RED is
      `E-M4-PROTECTED-MANIFEST-WORKFLOW-LOCAL-RED-001`; the seed signer is locally green under
      `E-M4-PROTECTED-MANIFEST-SEED-LOCAL-001` and all-six exact-head CI is closed by
      `E-M4-PROTECTED-MANIFEST-SEED-CI-001`. The filesystem prepare/finalize command is locally
      green under `E-M4-MANIFEST-AGGREGATE-COMMAND-LOCAL-RED-001` and
      `E-M4-MANIFEST-AGGREGATE-COMMAND-LOCAL-001`, with all-six exact-head CI closed by
      `E-M4-MANIFEST-AGGREGATE-COMMAND-CI-001`. The callable workflow remains open.
      Its disconnected three-job source contract is locally green under
      `E-M4-PROTECTED-MANIFEST-WORKFLOW-LOCAL-001`, and exact-head execution passes on all six native
      jobs under `E-M4-PROTECTED-MANIFEST-WORKFLOW-CI-001`. Live protected signing remains open; no
      accepted production key, environment, or seed is provisioned.
- [x] Add the disconnected relay-specific required-asset capability. It passes locally and on all
      six native jobs under `E-M4-RELEASE-ASSETS-LOCAL-RED-001`,
      `E-M4-RELEASE-ASSETS-LOCAL-001`, and `E-M4-RELEASE-ASSETS-CI-001`. Release/default workflow
      composition remains separately gated.
- [ ] Embed the exact signed manifest and accepted keys in each desktop build.
- [ ] Upload to a draft release, read back, re-hash, and execute the downloaded archives.
      A disconnected bounded upload/recovery implementation is locally green under
      `E-M4-DRAFT-UPLOAD-LOCAL-001` and passes all six native Node 24 jobs under
      `E-M4-DRAFT-UPLOAD-CI-001`; no real release write or downloaded archive execution has occurred,
      so this item remains open. The purpose-named transactional materialization RED is recorded
      under `E-M4-DRAFT-READBACK-MATERIALIZATION-LOCAL-RED-001`; one-pass persistence, exclusive
      temporary/final naming, cancellation/failure cleanup, and exact returned paths pass locally
      under `E-M4-DRAFT-READBACK-MATERIALIZATION-LOCAL-001`. Exact-head all-six Node 24 proof is
      closed under `E-M4-DRAFT-READBACK-MATERIALIZATION-CI-001`; downloaded archive execution and a
      real release write/read-back are still required. The purpose-named missing execution-boundary
      RED is recorded under `E-M4-READBACK-ARCHIVE-EXECUTION-LOCAL-RED-001`. Exact descriptor/path
      binding, exclusive extraction, full-tree verification, bundled Node/native smoke, cleanup,
      and real Darwin arm64 Actions-artifact execution pass locally under
      `E-M4-READBACK-ARCHIVE-EXECUTION-LOCAL-001`. All-six exact-head Node 24 archive execution is
      closed under `E-M4-READBACK-ARCHIVE-EXECUTION-CI-001`; a real authenticated release write/
      read-back remains open.
- [ ] Test timeouts, retries, approval denial, signing failure, partial output, and draft recovery.
      Disconnected upload/materialization/execution ordering, timeout/retry/partial-output stops,
      cancellation, identity drift, ownership-safe cleanup, and later-archive failure pass locally
      under `E-M4-DRAFT-RELEASE-COMPOSITION-LOCAL-001` and on all six native Node 24 jobs under
      `E-M4-DRAFT-RELEASE-COMPOSITION-CI-001`. Protected approval and real signing failure evidence
      remain blocked/open, so this item is not complete.

### WP4 — Desktop resolver and verified cache

- [ ] Select tuples offline from the embedded manifest and resolve immutable direct asset URLs.
      The verified immutable selection and URL boundary is locally green under
      `E-M5-OFFLINE-SELECTION-LOCAL-001`. The first post-push audit found that native jobs omitted
      these source suites; both job families are now locally pinned under
      `E-M5-OFFLINE-SELECTION-CI-WIRING-LOCAL-001`, and exact-head all-six native proof is closed by
      `E-M5-OFFLINE-SELECTION-CI-001`. The disconnected fixed-resource manifest loader is locally
      green under `E-M5-PACKAGED-MANIFEST-LOCAL-001`, and both native workflow command families are
      pinned under `E-M5-PACKAGED-MANIFEST-CI-WIRING-LOCAL-001`. Exact-head all-six native source
      proof is closed by `E-M5-PACKAGED-MANIFEST-CI-001`. Production keys, signed embedded bytes,
      builder mapping, packaged-app smoke, and a consumer remain open, so this item is not complete.
- [ ] Stream bounded downloads; verify signature, size, archive hash, and extracted tree.
      The disconnected Electron downloader is locally green under
      `E-M5-ARTIFACT-DOWNLOAD-LOCAL-RED-001` and `E-M5-ARTIFACT-DOWNLOAD-LOCAL-001`; exact-head
      all-six native CI is closed under `E-M5-ARTIFACT-DOWNLOAD-CI-001`. Disconnected strict
      TAR/Brotli and ZIP extraction plus complete-tree verification are locally green under
      `E-M5-ARTIFACT-EXTRACTION-LOCAL-001`; an exact full-size Actions payload is locally within time
      and memory budgets under `E-M5-ARTIFACT-EXTRACTION-FULL-SIZE-LOCAL-001`; all-six native
      execution is closed under `E-M5-ARTIFACT-EXTRACTION-CI-001`. Packaged signature loading
      remains open.
- [x] Add exclusive staging, atomic publication, quarantine, locking, and the 2 GiB cache policy.
      Locking and immutable publication/lookup/quarantine are closed locally and on all six native
      clients under `E-M5-ARTIFACT-CACHE-LOCK-CI-001` and
      `E-M5-ARTIFACT-CACHE-ENTRY-CI-001`. In-use leases, recency, exact byte accounting, and bounded
      eviction pass locally and on all six native/full-size clients under
      `E-M5-ARTIFACT-CACHE-EVICTION-LOCAL-001` and `E-M5-ARTIFACT-CACHE-EVICTION-CI-001`.
- [ ] Prove verified cached bytes can be transferred while the client is offline.
- [ ] Preserve `ORCA_RELAY_PATH` behind the official-build trust boundary.

### WP5 — SSH transfer and remote install

- [ ] Implement bounded, cancellable SFTP transfer.
- [ ] Implement POSIX system-SSH transfer with optional tar and mandatory no-tar support.
- [ ] Implement bounded binary PowerShell/.NET transfer for Windows system SSH.
- [ ] Transfer verified bytes into exclusive staging and hash the complete staged tree with bundled
      Node before native probes.
- [ ] Prove probe → PTY/watcher smoke → sentinel → atomic publish → launch ordering.
- [ ] Trust warm installs under the immutable-directory rule; quarantine detected mutation.
- [ ] Keep SSH authentication, connection, and relay RPC transport unchanged.

### WP6 — Modes, fallback, diagnostics, and races

- [ ] Implement internal `legacy`, `auto`, and forced diagnostic `bundled` modes.
- [ ] Fall back automatically only for classified availability/compatibility failures.
- [ ] Fail closed for signature, hash, archive/tree, native-trust, bundled-Node, and cache-corruption
      failures.
- [ ] Abort and await bundled work before eligible legacy fallback begins.
- [ ] Separate bundled/legacy identities, locks, staging, sentinels, and generations.
- [ ] Test reconnect, reattach, concurrent clients, cancellation, GC, upgrades, and downgrades.

### WP7 — Per-target Beta and validation

- [ ] Add the per-target mode field with safe migration/default tests.
- [ ] Add the Beta-tagged option to SSH target add/edit UI, off by default.
- [ ] Apply a mode change only on next connection or explicit reconnect.
- [ ] Add actionable fail-closed recovery and privacy-safe Beta telemetry.
- [ ] Run every enabled remote tuple through built-in SFTP and system SSH.
- [ ] Run every supported client OS/architecture against representative POSIX and Windows remotes.
- [ ] Prove no remote GitHub egress, no-tar bootstrap, full-size transfer, slow-link cancellation,
      concurrency, RPC, and failure-injection behavior.
- [ ] Measure cold/warm latency, memory, channels/files, cancellation settlement, and fallback delay
      against legacy.
- [ ] Ship only as per-target, off-by-default Beta; gather real-host evidence before default-on review.
- [ ] Require three qualifying RCs and rollback proof before any default-on proposal.

## External blockers

- [ ] Release administrator chooses and provisions representative SSH remote snapshots, credentials,
      egress rules, teardown SLA, and cost/capacity ownership.
- [ ] Release administrator provisions protected manifest/native-signing environments, reviewers,
      test keys/certificates, and access auditing.
- [ ] After a separately authorized merge, dispatch the reviewed exact-source native-signing
      rehearsal; GitHub cannot dispatch its new workflow file while it exists only in this PR.

While blocked, artifact-only and test work may continue. No tuple may be enabled or published.

## Final go/no-go gates

- [ ] Every enabled tuple has native build, oldest-baseline, native-trust, SFTP, system-SSH, RPC,
      security, and performance evidence.
- [ ] Every desktop build embeds the signed manifest for the exact immutable assets it ships.
- [ ] Beta rollback to the existing legacy mechanism is proven in the same build.
- [ ] All required matrix cells have evidence IDs in the detailed ledger.
- [ ] Default-on receives a separate review after the Beta soak; legacy remains available until a
      separately reviewed removal decision.
