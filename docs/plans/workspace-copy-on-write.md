# Workspace copy-on-write

Implemented on `nwparker/CoW`, baseline `9f7fd9a2706`. This document describes the
final design and recorded verification; local evidence paths refer to the author’s
session artifacts, not files required at runtime.

## Materialization contract

| Input | Preferred behavior | Fallback |
| --- | --- | --- |
| Worktree Shared Paths | Private CoW copy | Shared symlink; junction first for Windows directories |
| `.worktreeinclude` | Private CoW copy | Private byte copy admitted by a cumulative budget |
| YAML `sharedDirectories` | Shared link | Existing platform link policy |

Existing destinations survive. Copy mode resolves a top-level source symlink;
nested symlinks remain verbatim, including dangling links. Relative package links
therefore continue to work within the private copy. External nested links still
share their external referent. Destination files are never hardlinked to source
files. Existing config precedence and requested Git branch/base checkout semantics
remain unchanged. Ordinary directories can be materializer inputs; registering a
folder workspace does not start a new cloning lifecycle or require `.git`.

CoW shares initial data blocks, not future writes or directory entries. All selected
backends still perform O(entries) work. This is not a repository snapshot, a
constant-time tree operation, or a promise of zero disk usage.

## Architecture and tradeoffs

The existing path materializer owns copy/link/share policy and accounting. A backend
provides strict cloning and an advisory filesystem-pair prediction, cached only for
one materialization. Prediction never authorizes an implicit byte-copy fallback.

macOS uses a small packaged universal arm64/x86_64 helper targeting macOS 11.
A physical FTS walk invokes strict per-file `clonefile`, preserves symlinks, refuses
special files and crossed devices, and applies directory metadata after children.
It stages the complete tree, then publishes with `renamex_np(RENAME_EXCL)`.
Apple discourages cloning whole directories with `clonefile`; recursive forced
`copyfile` flags were also experimentally rejected with EINVAL. The selected native
walk avoids both and needs no compiler, Python, or experimental Node FFI at runtime.
The helper is packaged beside the executable and signed through the existing native
signing path. Development bundles include it in their source cache identity.

Linux uses `COPYFILE_FICLONE_FORCE` for files and `cp --reflink=always` for trees.
A failed strict cp can leave empty files, so cloning finishes in owned staging
before publication. Tree publication reserves an absent target and merges private
staging inodes using `cp -n -R -P --link --preserve=mode,timestamps`; these hardlinks
are to the clone, never the primary checkout. Unlike macOS, publication is not an
atomic tree transaction. Late publication failure reports a partial destination
and never starts a second byte-copy or symlink fallback. Staging cleanup changes
only owned directory permissions, never file inodes already published.

Windows retains private byte copies and shared junction/symlink fallbacks. ReFS
native block cloning is not implemented or advertised. Unsupported filesystems,
cross-volume copies and a missing macOS helper follow the same mode-specific policy.

`.worktreeinclude` uses the existing cumulative 2 GiB / 50,000-entry admission limits
and a bounded sizing-work allowance. Strict CoW omits byte charges, but retains the
entry charge. Every actual byte fallback is charged even after a positive prediction
or a later unavailable verdict. Sizing uses directory entries and bounded concurrent
stats. Byte copies preserve verbatim symlinks. Failures, partial copies, interruptions
and budget refusals have distinct warnings.

A snapshot manager would add another registry, hooks, garbage collection and Git
identity model. Whole-source snapshots also bring dirty source state instead of
checking out the requested base. Repository conversion to subvolumes would replace
source identity under open processes. Those lifecycle changes are outside this
optimization. A dependency seed store needs a separate design for cache identity,
platform/ABI, trust, mutation isolation and eviction.

## Execution hosts and compatibility

SSH advertises optional `worktreeMaterializationVersion: 1` through the incumbent
filesystem capability cache. New clients call `fs.materializeWorktreePaths` only
when supported. The host reads its own includes, YAML and Git ignore configuration.
Old hosts get no unknown method and return an explicit unsupported warning. Transport
errors are unverifiable and stop creation before setup; clients never copy remotely
owned files locally or retry an uncertain request. There is no new stream opcode.
The macOS helper is an optional hashed relay artifact, omitted safely by non-Mac
builders. Its resolver repairs executable permission after plain-file delivery.

WSL desktop and runtime creation use the incumbent `runWslProcess` runner with
preferred login PATH, guest path conversion and a bundled Node entry. Node >=18 is
required in the guest. Base64 JSON in a quoted JavaScript heredoc preserves request
metacharacters; the incumbent runner handles large scripts over stdin. Missing
Node/bundle or invalid/uncertain completion stops setup. There is no Windows
filesystem fallback or new runtime installer.

SSH deletion adds optional shared-link context to existing clean/remove RPCs.
The execution host reads YAML, validates actual symlinks and ancestors, and excludes
tracked paths using Git 2.25-compatible literal `ls-files` arguments. Non-force
removal rechecks dirtiness before unlinking. Old hosts retain their dirty verdict;
clients never override it. WSL inspect/unlink operations reuse that host policy,
inspect before preflight, and unlink only after terminal teardown. General SSH
status presentation still uses its existing policy; explicit removal has parity.

## Failure and concurrency boundaries

Staging/probes use exclusive `mkdtemp` ownership. Clone subprocesses have a 120-second
bound and 16 KiB output cap, detached groups and the shared runner’s termination
barrier. Only `onChildTerminated` establishes exit. Unverifiable interruption keeps
staging/reservations and stops creation before setup/startup. Link-mode interruptions
also throw; confirmed-exit include interruption reports a partial warning.

Preflight refuses linked/non-directory target ancestors and recursive copies into
the source. macOS publication and file link publication preserve an existing target.
These checks do not provide descriptor-relative containment against a concurrently
replaced ancestor. A concurrently modified source is not a consistent snapshot,
and pre-copy sizing is an admission guard, not a hard quota against source growth.
Linux directory publication may leave a partial tree on failure. Such a tree is
reported and preserved for inspection; it is not recursively deleted as “cleanup.”
Avoid concurrent writers during materialization. Fully adversarial filesystem races,
transactional Linux tree publication and immutable snapshots need separate work.
Metadata preservation differs by backend; there is no cross-platform ACL/xattr
identity guarantee. Nested mount refusal has native implementation coverage, not a
complete real mounted-tree matrix. No OpenZFS, ReFS, network-share CoW, Intel runtime,
or signed/notarized release validation is claimed.

## Exercised evidence

| Environment | Recorded result |
| --- | --- |
| Local APFS and second arm64 Mac | Production private clones, budget exemption, relative/dangling links, read-only directories, existing-target preservation |
| Docker XFS and btrfs | Strict production tree/file CoW, private edits and cleanup |
| Docker overlay and tmpfs | Expected private-copy/shared-link fallback |
| Native Windows | Private copies, budget refusal, directory junction sharing and cleanup |
| Windows → WSL Ubuntu 24.04 | Full production wrapper and login-PATH discovery, guest materialize/inspect/unlink |
| SSH Linux | Actual production mux + filesystem/Git providers + isolated rebuilt relay; materialize, private/shared edits, clean non-force removal |
| HFS+ and APFS → HFS+ | Unsupported and cross-volume budget refusal, private-copy fallback and shared-link fallback |

All fixtures used temporary roots. Owned Docker mounts, the HFS+ disk image,
remote relay and paired terminals were cleaned up. SSH macOS helper placement and
mode-0644 executable repair passed on a second Mac via paired-terminal delivery;
SFTP uploader behavior was inspected separately, not exercised for that transfer.

Reusable exercises live in `config/scripts/exercise-worktree-cow.mjs`,
`exercise-worktree-path-operations.mjs`, `exercise-worktree-ssh-rpc.ts`,
`prepare-worktree-ssh-exercise.mjs` and `exercise-worktree-wsl-wrapper.ts`.
For a direct host filesystem exercise, bundle `src/main/ipc/worktree-symlinks.ts`
with esbuild (Node/CJS), put the native helper beside it on macOS, then run:

```sh
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/exercise-worktree-cow.mjs <bundle> <temporary-filesystem-root> <clone-or-fallback>
```

Native regression tests compile the helper and cover private file/tree clones,
modes, symlinks, special-file refusal and raced no-replace publication. Unit and
integration coverage includes accounting after failed predictions, staging ownership,
partial publication without fallback, real child timeout, setup interruption,
old-host refusal, guest request quoting, dirty/tracked link protection and removal
ordering. Full typecheck and changed-code quality passed before final review; final
verification results are recorded below. The production desktop build also passed.

Settings copy and six locale strings explain private host-filesystem CoW and shared
fallback edits. Rendered English was checked in an isolated background Electron app
through Playwright CDP with exact worktree identity; no focus or visible test window.
Screenshot: `/tmp/orca-cow-settings.png`. Owned app and profile daemon were stopped.

## Performance evidence

Six alternating trials on the same warm-cache synthetic dependency-style tree:
5,004 files, 101 directories, 77,348,864 logical bytes. Native strict per-file cloning
median 584 ms (546–1,051 ms), versus `/bin/cp -cR` median 790 ms (720–888 ms).
Maximum observed child RSS: 1.56 MiB native, 1.47 MiB cp. This is a busy-host
microbenchmark, not a guaranteed workload speedup. The native walk remains O(entries).
Samples: `/tmp/orca-cow-benchmark.json`; script: `/tmp/orca-cow-benchmark.mjs`.

## Evidence index

Local session logs: `/tmp/orca-cow-live-ssh.log`,
`/tmp/orca-cow-wrapper-evidence.json`, `/tmp/orca-cow-mac-result.json`,
`/tmp/orca-cow-hfs-evidence.log`, `/tmp/orca-cow-linux-filesystems.log`,
`/tmp/orca-cow-review-suite.log`, `/tmp/orca-cow-review-fixes.log`,
`/tmp/orca-cow-removal-real-git.log`, `/tmp/orca-cow-production-build.log`.
Cross-volume result: `budgetEnforced`, `privateFallback`, `sharedFallback` all true.

## Final local checks

- `pnpm tc`: passed all projects.
- `pnpm run check:code-quality:changed`: zero new ordinary, type-aware or
  React Doctor findings across 68 changed source files.
- All 22 changed test files: 266 passed, four Linux-only tests skipped on macOS.
  Real Linux filesystem evidence above covers strict production cloning separately.
- `pnpm run build:desktop` and `pnpm run build:native`: passed.
- `electron-builder --mac --arm64 --dir`: passed; unsigned/unnotarized app package.
  The packaged CoW helper was copied into an isolated exercise bundle and passed
  the APFS production materializer exercise (235 ms for the small fixture).
  Packaging preceded the final Linux partial-publication error fix; final source
  tests/typecheck cover that fix, while package evidence validates native delivery.
- `git diff --check`: passed.

Final logs: `/tmp/orca-cow-final-tests.log`, `/tmp/orca-cow-final-tc.log`,
`/tmp/orca-cow-final-quality.log`, `/tmp/orca-cow-package.log`,
`/tmp/orca-cow-packaged-exercise.log`. Full repository lint/tests and signed release
packaging were not run; no broader pass claim is implied.
