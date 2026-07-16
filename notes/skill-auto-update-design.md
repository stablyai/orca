# Skill Auto-Update Design

Status: SUPERSEDED in direction by `skill-freshness-design.md` (2026-07-13): Phases 2-4
(background writes, WSL, SSH reconcilers) are retired; Phase-1 detection and all empirical
findings below remain valid inputs. Original status: revised after design, OSS review, and
macOS + Windows + Linux empirical validation (2026-07-12). Phase 1 + background updates were
implemented on PR #8496 (branch brennanb2025/skill-auto-update-research), now archived as
reference for the write machinery. Windows validation confirmed the skills CLI writes CRLF (drove the
text-normalized package-identity rule); Linux confirmed verbatim-LF installs and the
`XDG_STATE_HOME` lock-location rule.

## Problem

Orca ships agent skills in `skills/` (orca-cli, orchestration, computer-use, orca-linear,
linear-tickets, orca-per-workspace-env, orca-emulator, orca-emulator-android). Users install
them with the skills CLI:

```sh
npx skills add https://github.com/stablyai/orca --skill <names> --global
```

Nothing then keeps those installations aligned with the Orca release they describe. Settings
surface a manual `npx skills update <name> --global` command, but users receive no update
signal. A stale skill can therefore tell an agent to use commands that are wrong or unsafe for
the Orca binary it is driving.

## Goals

1. Keep an Orca skill current after Orca has safely adopted or installed that physical copy.
2. Never overwrite a modified, unknown, externally managed, project-scoped, or third-party
   skill.
3. Never install a skill the user did not request.
4. Work on macOS, Linux, Windows, WSL, and SSH, with reconciliation performed on the host
   where the agent reads the skill.
5. Coexist with the skills CLI, symlink and copy installs, dotfile managers, read-only or
   generated configurations, and multiple Orca builds sharing a home directory.
6. Keep skill content compatible with the Orca app release that is allowed to manage it.

Non-goals: updating third-party skills; replacing the skills CLI as the normal install path;
managing repo-scoped `.agents/skills` or `.claude/skills`; mutating plugin caches; merging user
edits into a new skill release.

## Research conclusion

The common package-manager pattern is not to scan arbitrary same-named directories and infer
that they are writable. The updater manages packages inside an ownership boundary established
at install or adoption time, records package identity outside user content, stages a complete
replacement, and treats external links/custom installations as unmanaged.

The skills CLI lock is useful supporting evidence, but it is not an ownership ledger:

- The global lock is `$XDG_STATE_HOME/skills/.skill-lock.json` when `XDG_STATE_HOME` is set,
  otherwise `~/.agents/.skill-lock.json`.
- A v3 entry records source, source URL/type, Git ref, path within the repo, an upstream folder
  hash, and timestamps.
- It does not record a physical install path, symlink/copy topology, per-skill global agent
  placements, the current on-disk hash, local modifications, or app compatibility.
- `skills update` compares the stored source hash with upstream and then re-runs installation.
  It does not prove that installed files are unchanged first.

Orca therefore reads supported lock versions as a provenance hint but never treats a lock
entry by itself as permission to write. Orca never writes the foreign lock format.

## Decision: detect, adopt, then manage

Only a physical destination recorded in Orca's management ledger is eligible for background
writes. A destination enters that ledger in one of two ways:

1. Orca's install UI invokes the skills CLI and then verifies and records the resulting
   physical installation.
2. A legacy installation is adopted after its complete on-disk package matches a known,
   released Orca snapshot and its topology is eligible. Phase 1 makes this an explicit
   “Manage and update” action. Background auto-update never silently claims a newly
   discovered path.

This one-time adoption cost is intentional. Without it, no app can distinguish an official
copy from a same-named user copy or establish which manager is allowed to replace it.

Do not rely on users discovering adoption passively in settings. When the bounded inventory
finds exact official snapshots in eligible topologies, show one non-repeating banner/toast:
“N installed Orca skills can be kept up to date,” with a one-click review/adoption action.
Prioritize recording ownership immediately after every successful Orca-driven skills CLI
install so new installations never require a later adoption step.

“Non-repeating” is scoped per eligible destination snapshot, not globally or per session. Store
a dismissed-adoption tuple containing host identity, physical destination identity, skill name,
and matched snapshot digest. Do not prompt again for that unchanged tuple, but allow a future
prompt when a newly installed skill or genuinely different official snapshot creates a tuple
the user has never dismissed. Removing another candidate alone does not clear prior dismissals.

## Build and release artifacts

Package `skills/` into app resources on every supported platform and generate a current bundle
manifest. For each skill it contains:

- canonical name and repo-relative source path;
- release revision and Orca app version;
- deterministic whole-package digest (composed from the per-file identities below);
- every regular file's relative path, size, executable bit, a per-file text/binary
  classification, an exact-byte SHA-256, and — for text files — a text-normalized SHA-256 with
  line endings folded to LF;
- the upstream Git tree SHA when available;
- minimum/maximum compatible app version if a skill is not backward-compatible;
- schema version.

The build rejects absolute paths, traversal, case-colliding paths, special files, and symlinks
inside the shipped package. Executable modes and the exact bytes of binary files are part of
package identity. For text files, identity is the line-ending-normalized content, not the exact
bytes: supported installers apply platform- and Git-config-dependent EOL translation, so an
exact-byte hash is not stable across hosts. This is validated, not hypothetical — the skills CLI
writes CRLF on a default Windows Git install (see Empirical validation), so a macOS-built
exact-byte hash never matches a Windows install and would misclassify every Windows copy as
modified. Because the whole-package digest composes the per-file normalized-or-exact hashes, one
official snapshot has a single identity across macOS, Linux, and Windows and across
`core.autocrlf` settings.

Maintain a compact, checked-in registry of every generated Orca skill snapshot plus a separate
release mapping that identifies which revisions actually shipped. Historical file bytes are
unnecessary; historical paths and hashes are sufficient to prove that an existing package is
an exact official snapshot and to map a skills CLI folder hash to an Orca release. Only a
revision present in the release mapping is eligible as legacy-install provenance; an
unreleased candidate cannot be adopted merely because it appeared on main.

Release revision assignment is mechanical, not a hand-edited field. The manifest generator
compares each package digest with the latest generated registry entry: unchanged content keeps
its revision; changed content appends the next integer. The generator is the only writer of
registry entries, and existing entries are immutable. Pull-request CI verifies generated
output, but the same generation/monotonicity check must rerun against the merge-queue head and
on main pushes so two independently green PRs cannot record different content with the same
revision. Release creation adds the current revisions to the release mapping and fails unless
main's generated registry is current and the packaged manifest exactly matches it.

Do not rely on `metadata.version` inside `SKILL.md` as the authority. Installers can transform
frontmatter, users can edit it, and a value inside the package cannot prove the rest of the
package is intact.

The exact-snapshot model depends on supported skills CLI installations preserving the shipped
package. Add a release CI round trip on macOS, Linux, and Windows that installs representative
single- and multi-file Orca skills through a pinned supported CLI version in both symlink and
copy/fallback shapes, then compares paths, bytes, and applicable executable modes with the
generated bundle manifest. Also exercise the newest CLI as an early-warning job. The bundle
manifest remains generated from Orca's shipped source; if an installer intentionally transforms
content, model that installation shape explicitly or mark it ineligible rather than silently
changing the authoritative digest. A mismatch blocks background-update rollout for that shape.
macOS verbatim behavior and Windows CRLF translation are both confirmed (see Empirical
validation); the round trip must assert LF-normalized identity holds — not exact bytes — and
cover `core.autocrlf` on/off plus the copy-fallback and junction shapes as a regression guard.

## Eligible roots and topology

Use an explicit registry of global, user-owned skill roots. Do not derive writable roots from
all discovery sources: discovery also includes repo roots and the Codex plugin cache, neither
of which this feature may mutate.

Classify every discovered physical destination before offering adoption:

| Installation topology | Behavior |
| --- | --- |
| Canonical `~/.agents/skills/<name>` with a known official snapshot | Eligible for adoption |
| Provider symlink/junction resolving to that canonical copy | Dedupe; manage the canonical copy once |
| Independent copy in an approved global provider root with a known official snapshot | Eligible for separate adoption |
| Modified, incomplete, or unknown same-named copy | Never auto-write; show diff/replacement action |
| Symlink/junction into dotfiles, a checkout, Nix/Home Manager output, network storage, or another external tree | Unmanaged; never write through the link |
| Broken/dangling provider symlink (target missing) | Inaccessible; never adopt or write through; offer provenance-verified repair only with consent |
| Read-only/generated root | Detection only |
| Repo-scoped skill or plugin cache | Out of scope; never mutate |

Hardlinks, directory junctions, case-insensitive aliases, and symlinked parent directories must
be deduplicated by physical identity where the host API exposes it, with normalized real paths
as the fallback. Revalidate the entry type and resolved parent immediately before every
mutation so a link swap cannot redirect a verified write.

Management and agent visibility are separate. Updating a canonical `~/.agents/skills` copy
does not make it visible to an agent that reads only its provider-specific root. If no verified
provider link/copy exists, settings must say “managed but not visible to <agent>” rather than
reporting the provider as current. Creating or repairing a provider link is a separate,
provenance-verified, user-approved follow-up; auto-update never invents a missing placement.

## Orca management ledger

Store state in Orca-owned application state on the execution host, never inside a user skill
directory. Use one record per adopted physical destination:

- stable execution-host identity and user/home identity;
- logical root kind and unresolved destination path;
- last verified physical identity, entry type, and resolved path;
- skill name, source, source path, and source ref/hash evidence;
- installed release revision and whole-package digest;
- per-file paths, hashes, modes, and the digest Orca last wrote;
- last attempted bundle fingerprint, outcome, and error category;
- adoption source and timestamp.

Local, WSL distro, and SSH records are isolated. SSH identity must include the persisted target
identity plus the resolved remote user/home; an in-memory provider object or relay connection
ID is not durable identity. Host-side state lets a remote remember ownership across desktop
reinstalls and reconnects.

Corrupt, missing, migrated, or mismatched state fails closed. It can be reconstructed only by
the same exact-snapshot adoption rules; it never grants ownership from a name alone.

## Detection and adoption

For each Orca skill found in an approved global root:

1. `lstat` the logical path and classify its topology without following external targets for
   mutation.
2. Dedupe aliases that resolve to the same eligible canonical destination.
3. Read the supported skills CLI lock as optional evidence. Bind a lock entry only to the
   canonical installation shape it describes; never apply one name-level entry to every
   same-named copy.
4. Hash the complete physical package — exact bytes for binary/executable files, LF-normalized
   content for text files — and compare with the released-manifest registry, so installer EOL
   translation never misclassifies an official Windows install as modified.
5. Classify it as current, update available, newer known release, modified, unknown,
   externally managed, or inaccessible.
6. Offer “Manage and update” only for an exact known official snapshot in an eligible
   topology. Show a diff and explicit destructive replacement action for modified/unknown
   content; that action is not adoption and must preserve a backup until success.

Never send skill contents, diffs, paths, or user edits to telemetry or normal logs.

## Reconcile algorithm for adopted destinations

For each adopted physical destination whose bundle revision is newer and app-compatible:

1. Acquire an Orca transaction lock scoped to the execution host and destination. Dedupe
   in-flight work within the process as well. Other managers do not honor this lock, so also
   revalidate immediately before publish.
2. Re-read topology and hash the installed package. Continue only when it equals the exact
   digest in the ledger. Any local edit, extra file, missing file, skills CLI update, or link
   change turns the destination into a conflict and cancels the write.
3. Stage the complete bundled package in a unique directory under the reserved transaction
   workspace on the same filesystem. Write exact bytes and modes, then validate the staged
   package against the manifest.
4. Recheck the live destination digest and identity after staging. If either changed, delete
   the staging directory and report a concurrent modification.
5. Publish using the strongest package-level replacement supported by that host. Consumers
   require a fixed skill path, so a universally atomic directory swap is not possible,
   especially on Windows. Where package-level replacement is unavailable, first preserve a
   complete rollback copy, then use this required order:
   1. publish every new/changed non-`SKILL.md` file with same-directory temp + rename;
   2. publish `SKILL.md` with same-directory temp + rename as the semantic commit marker;
   3. unlink only obsolete files recorded in the old ledger, rechecking that each still has
      its old verified hash, then remove only empty recorded directories.
   This order ensures a removed file cannot make the new digest permanently unreachable and
   avoids deleting an asset while the new entry point is not yet present. It does not make a
   multi-file update atomic: a reader may briefly observe the old entry point with new assets,
   or the new entry point with harmless obsolete assets. Skills requiring cross-file atomicity
   must use package-level replacement; if the host cannot provide it, skip and retry rather
   than use the in-place fallback. Do not claim stronger consistency than the host provides.
6. Verify the live package digest. Only then update the destination ledger and remove the
   backup. On failure, restore the old package when possible, retain the prior ledger digest,
   and leave the destination retryable.
7. Notify discovery and show one aggregated toast for successfully updated skills. Running
   agent sessions pick changes up at their next skill load/session start.

Never repair equal-revision drift automatically. Equal revision plus different content is a
conflict, not proof of a partial write. Never downgrade a known newer release.

Line endings are a rendering of text content, not part of it. The bundle ships LF, but supported
installers write platform-native endings (validated: CRLF on default Windows Git). Compare text
provenance and drift on LF-normalized content; stage and publish text files in the destination's
existing EOL convention, defaulting to what a fresh supported install would produce on that host
when adopting a copy that has none; write binary and executable files as exact bytes. This keeps
an updated file byte-shaped like a fresh CLI install, so an EOL difference alone never counts as
a conflict and Orca and the skills CLI do not reclassify each other's writes.

### Transaction workspace and crash recovery

Staging and rollback packages must be on the same filesystem/volume as the live destination,
but must not appear as candidate skills. Use an Orca-reserved transaction root adjacent to the
skill root when possible (for example, beside `skills/`, not as another child skill), verify
same-filesystem identity, and fall back to a reserved child only when the skill root is itself
a mount boundary. Both general skill discovery and updater inventory must hard-exclude the
reserved transaction root; a leading dot alone is not an exclusion rule.

Each transaction directory contains an Orca marker with schema version, transaction ID,
destination identity, creation time, and an atomically advanced transaction phase before it
receives skill files. On host startup and before reconciliation, sweep only marked orphan
transactions whose owning lock is absent/stale: restore a verified rollback package when the
marker/ledger phase says publication was incomplete, otherwise remove the verified
staging/backup directory. Never delete an unmarked directory based on its name, age, or
resemblance to a skill. Coordinate cleanup with the same destination lock so one Orca process
cannot sweep another process's live transaction.

### Removed files and retired skills

Package-level replacement naturally omits files removed by a newer managed package. The
in-place fallback explicitly removes old-ledger files after publishing the new `SKILL.md`, as
specified above. Never delete an unrecorded extra file from a live destination; its presence
causes the pre-publish digest check to fail before any write.

Retired skills are detection/prompt-only in the initial implementation. A future cleanup may
delete only individually recorded, unchanged files and then empty directories. It must never
recursively delete a skill directory or follow a link target.

## Fast path and triggers

State is per destination, not one success bit for an entire host. A failed, inaccessible, or
partially reconciled destination remains retryable even when other destinations succeeded.

At launch, after first paint:

1. Perform a bounded inventory of approved global roots to detect newly installed, removed,
   or topology-changed Orca skills.
2. For adopted destinations, skip content hashing only when that destination already records
   successful reconciliation with the current bundle and its cheap identity/stat signature is
   unchanged.
3. Hash only new, changed, failed, or bundle-mismatched candidates.

Also run/invalidate on:

- successful Orca-driven skill installation;
- `notifyInstalledAgentSkillsChanged()` after an install/update terminal exits;
- WSL distro first activation;
- SSH connection after the host runtime is ready;
- restart into a newly installed Orca app version.

Do not reconcile on the updater's “download complete” event: the running process still owns
the old app resources until restart. Coalesce triggers and cap concurrency so launch, WSL, and
SSH activation cannot fan out unbounded filesystem or network work.

## Host execution

- **macOS/Linux:** use Node filesystem APIs and platform app-state paths; do not shell out.
- **Windows:** use `path` APIs, preserve exact bytes, support junction/copy topology, handle
  case-insensitive identity and long/UNC paths, and retry bounded `EPERM`/`EBUSY` replacement
  failures. A skipped destination remains retryable and never advances its ledger digest. A
  long-running agent may keep an obsolete file open; if its hash-verified unlink still fails
  after bounded retries, roll back the whole update and retry after the handle is released.
- **WSL:** run reconciliation inside the selected distro through a host-side runtime/RPC
  operation. Do not mix Windows UNC mutation semantics with Linux locks, modes, and renames.
  State is scoped to distro plus Linux user/home.
- **SSH:** run discovery, hashing, staging, locking, and publication on the remote host through
  the runtime/filesystem abstraction. Transfer only the selected bundled package and manifest.
  Do not assemble shell commands. Support Linux, macOS, and Windows SSH targets, and fail closed
  when the remote runtime lacks a required safe filesystem primitive.

## Multiple writers and app compatibility

The same global roots may be touched by stable Orca, a development build, and the skills CLI.
Orca cannot guarantee that one shared global package simultaneously matches two incompatible
app binaries.

- Production stable Orca is the only automatic writer by default.
- Main-process runtime identity is authoritative: `app.isPackaged`, the signed release channel,
  and the resolved user-data/home roots determine whether writes are allowed. Renderer build
  flags alone are insufficient. An unpackaged build or development channel is detection-only
  unless both skill home and user-data roots are explicitly isolated from production.
- A stable app writes only a bundle declared compatible with that app version.
- A newer known installed release is never downgraded.
- If `npx skills update` changes an adopted package, the next Orca check sees a ledger-digest
  mismatch and stops managing it until the new content matches a known released snapshot and
  is explicitly re-adopted.
- Provenance and drift comparison fold text line endings to LF, so a stable app and the skills
  CLI never treat each other's platform-native EOL output as a conflict; only real content
  changes do.
- Skills should remain backward-compatible across supported stable app versions where
  practical; compatibility metadata is still required for exceptions.

This avoids version ping-pong. A monotonic number inside user content alone cannot solve
multiple incompatible writers.

## Consent and settings UX

The background setting is “Keep managed Orca agent skills up to date.” It controls only
already adopted/Orca-installed destinations and may default on. It does not authorize claiming
new paths.

Settings show each physical installation as one of:

- managed and current;
- managed, update available;
- known official copy, available to manage;
- modified/unknown, review required;
- externally managed/read-only;
- inaccessible or update failed.

Managed and known-snapshot rows show the released skill revision, Orca app release, and a short
digest for human/support diagnosis. Do not add a second, non-authoritative version marker to
`SKILL.md`; it can be transformed independently of the package and mistaken for write
authority.

Every successful background batch produces one toast. Conflicts and failures remain visible in
settings without repeated error toasts. Explicit replacement shows a local diff, warns that it
discards edits, and keeps a rollback backup until verification succeeds.

## Empirical validation (2026-07-12, macOS + Windows + Linux)

Both load-bearing assumptions were tested on a real developer machine against live installed
skills, not deferred to Phase 1 telemetry. Results are recorded so the evidence travels with
the design.

- **Verbatim install (decisive).** A clean-room `npx skills add https://github.com/stablyai/orca
  --skill orca-cli orchestration --global --yes` into a throwaway home produced files
  byte-identical to `origin/main`: equal Git blob hashes, equal byte counts, zero CRLF, exactly
  one `SKILL.md` per skill, and no injected or stripped files. The CLI does not transform content
  on macOS, so exact-content provenance is viable.
- **Historical-snapshot match on real stale installs.** The machine's genuinely stale `orca-cli`,
  `computer-use`, and `orchestration` have on-disk bytes that exist verbatim as committed Git
  blobs in repo history. Exact-content adoption against a released-snapshot registry would
  recognize real, messy installs — not just freshly installed ones.
- **Release-mapping guard justified by data.** Those stale blobs are reachable at commits dated
  after their recorded install time, i.e. identical bytes existed in a checkout/branch before or
  independently of shipping. Presence in history is therefore not proof of an official release;
  adoption must gate on the release mapping, and content identity — never timestamps — is the
  arbiter. This is exactly the hole the separate release mapping closes.
- **Topology and dedup.** Provider skills under `~/.claude/skills` are symlinks (both relative
  `../../.agents/...` and absolute forms) into canonical `~/.agents/skills`; realpath resolution
  collapses provider and canonical to one physical destination, confirming physical-identity
  dedup yields a single write. A live broken/dangling provider symlink was also present (target
  missing), which is why the topology table has an explicit inaccessible row.
- **Lockfile corroboration present (macOS).** Lock entries carry `source: stablyai/orca` and a
  folder hash, usable only as corroboration, consistent with the design.

**Windows (2026-07-12, validated on a real machine via the handoff below).** A clean-room
`npx skills add ... --skill orca-cli --global` on a default, non-Developer-Mode Windows install
produced:

- **CRLF translation, not byte-identical.** Installed `SKILL.md` was 21180 bytes with 318 CR
  bytes; repo-main source was 20862 bytes with 0 CR. The size delta equals the CR count exactly,
  i.e. a pure LF→CRLF translation with identical text. This is why text-file package identity is
  LF-normalized rather than exact-byte; an exact-byte model would have adopted nothing on Windows.
- **Copy-fallback shape.** `.agents\skills\orca-cli` was a plain directory copy (no link), and no
  `.claude` provider copy was created (Developer Mode off, process unelevated). Confirms the
  Windows copy path and the need to manage independent per-root copies, not only a canonical
  symlink target.
- **Same file set.** Only `SKILL.md` in both source and install — no injected or stripped files.
- **Lockfile populated.** The lock recorded `orca-cli`; the known Windows empty-lockfile bug did
  not reproduce on this machine/version. Corroboration signal is therefore sometimes available on
  Windows, but the design still relies on content-match as primary since it is not guaranteed.

Still gated behind the cross-platform CI round trip as a regression guard, and untested:
`core.autocrlf=false` on Windows (would install LF), and the junction/symlink shape under
Developer Mode. LF-normalized identity covers the autocrlf variance by construction.

**Linux (2026-07-12, throwaway Docker container, reached over SSH).** Ran the same clean-room
install on `Linux 6.12 aarch64` (node 22, npx 10.9, git 2.39). The container served SSH (sshd
listening); the CLI check was executed on the box, since SSH transport does not change what the
CLI writes to disk:

- **Verbatim LF, like macOS.** `orca-cli` and `orchestration` installed byte-identical to
  `origin/main`: equal SHA-256, exact byte counts (20862 / 22850), **CR=0**, only `SKILL.md` in
  each dir. Linux needs no separate manifest shape — it is covered by the LF identity.
- **Symlink topology.** `~/.claude/skills/orca-cli` is a relative symlink
  (`../../.agents/skills/orca-cli`) into the canonical `~/.agents/skills` copy, matching macOS;
  realpath dedup collapses provider and canonical to one write.
- **XDG lockfile path confirmed, with a sharper rule.** With `XDG_STATE_HOME` unset the lock is
  `~/.agents/.skill-lock.json` (`source: stablyai/orca`); with `XDG_STATE_HOME` set the lock is
  at `$XDG_STATE_HOME/skills/.skill-lock.json` and **not** at `~/.agents` — it moves, it is not
  duplicated. So the corroboration reader must resolve `XDG_STATE_HOME` and read the single
  correct location; checking only `~/.agents` finds no lock at all on such hosts. This is a
  property of the Linux/host environment, not of Orca's SSH transport, so it applies equally to
  native Linux, WSL, and SSH Linux targets — the reconciler must resolve the remote host's
  `XDG_STATE_HOME` when reading lock corroboration remotely.

Not exercised here: Orca's own remote reconciler over SSH (Phase 4, unbuilt — nothing to drive
yet). This validated the Linux CLI install shape and the remote lock-location rule the reconciler
will depend on.

## Windows validation handoff

Result (2026-07-12): **FAIL — CRLF translation**, resolved by LF-normalized text identity (see
Build and release artifacts and Empirical validation). The procedure is retained for CI
regression and for the still-untested `core.autocrlf=false` and Developer-Mode junction shapes.

Give this to an agent on a Windows machine. It is self-contained, non-destructive (sandboxes the
skills CLI to a throwaway profile), and requires only PowerShell, Node/npx, and Git. It answers
one question: does `npx skills add` on Windows write skill bytes identical to the repo source, or
does it translate line endings / change the file set — and where does the lockfile land.

Goal and pass/fail:

- PASS (design safe as written): the installed `SKILL.md` is byte-identical to the repo source
  (equal SHA-256, equal byte count, zero CRLF), and the skill directory contains the same file
  set as the source.
- FAIL (design must model the Windows shape explicitly or mark it ineligible): the installed file
  differs only by CRLF/line endings, or the file set differs, or the lockfile `skills` object is
  empty after a successful install (the known Windows lockfile-not-written failure), which means
  lockfile corroboration is unavailable on Windows and content-match must carry provenance alone.

Run this in PowerShell and paste the full transcript back:

```powershell
$ErrorActionPreference = 'Stop'
$sandbox = Join-Path $env:TEMP ("orca-skilltest-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $sandbox | Out-Null
# Sandbox the CLI's global install to a throwaway profile so real skills are untouched.
$old = @{ USERPROFILE=$env:USERPROFILE; HOME=$env:HOME; XDG_STATE_HOME=$env:XDG_STATE_HOME }
$env:USERPROFILE = $sandbox; $env:HOME = $sandbox; Remove-Item Env:XDG_STATE_HOME -ErrorAction SilentlyContinue
try {
  npx --yes skills add https://github.com/stablyai/orca --skill orca-cli --global --yes 2>&1 | Tee-Object "$sandbox\install.log" | Out-Null

  $installed = Join-Path $sandbox '.agents\skills\orca-cli\SKILL.md'
  $truth     = Join-Path $sandbox 'truth-SKILL.md'
  # Ground truth = exact bytes Git stores on main (LF), fetched without transformation.
  Invoke-WebRequest 'https://raw.githubusercontent.com/stablyai/orca/main/skills/orca-cli/SKILL.md' -OutFile $truth

  function Info($label,$f){
    if(!(Test-Path $f)){ Write-Host "$label`: MISSING"; return }
    $bytes=[IO.File]::ReadAllBytes($f)
    $crlf=($bytes | Where-Object {$_ -eq 13}).Count
    Write-Host ("{0}: sha256={1} bytes={2} CR={3}" -f $label,(Get-FileHash $f -Algorithm SHA256).Hash.Substring(0,16),$bytes.Length,$crlf)
  }
  Write-Host "`n=== byte fidelity ==="
  Info 'installed' $installed
  Info 'repo-main ' $truth
  $same = (Get-FileHash $installed -Algorithm SHA256).Hash -eq (Get-FileHash $truth -Algorithm SHA256).Hash
  Write-Host ("VERDICT: {0}" -f ($(if($same){'VERBATIM (pass)'}else{'DIFFERS (inspect CR counts: CRLF-only diff = autocrlf translation)'})))

  Write-Host "`n=== link shape (junction/symlink/copy) for provider + canonical ==="
  foreach($p in @("$sandbox\.claude\skills\orca-cli","$sandbox\.agents\skills\orca-cli")){
    if(Test-Path $p){ $i=Get-Item $p; Write-Host ("{0} -> LinkType={1} Target={2}" -f $p,$i.LinkType,($i.Target -join ',')) }
    else { Write-Host "$p -> (absent)" }
  }

  Write-Host "`n=== file set in installed skill dir (extra/stripped files?) ==="
  Get-ChildItem (Join-Path $sandbox '.agents\skills\orca-cli') -Recurse -File | ForEach-Object { $_.FullName.Substring($sandbox.Length) }

  Write-Host "`n=== lockfile location + whether skills object populated (Windows #-not-written bug) ==="
  foreach($lp in @("$sandbox\.agents\.skill-lock.json", "$env:XDG_STATE_HOME\skills\.skill-lock.json")){
    if($lp -and (Test-Path $lp)){
      $j=Get-Content $lp -Raw | ConvertFrom-Json
      Write-Host ("{0} -> skills keys: {1}" -f $lp, (($j.skills.PSObject.Properties.Name) -join ','))
    }
  }
} finally {
  $env:USERPROFILE=$old.USERPROFILE; $env:HOME=$old.HOME; if($old.XDG_STATE_HOME){$env:XDG_STATE_HOME=$old.XDG_STATE_HOME}
  Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "`n(sandbox removed; your real skills were never touched)"
}
```

Also report, in words: (1) is Windows Developer Mode on (decides whether junctions or copy
fallback occurred)? (2) the VERDICT line, (3) whether CR counts differ between installed and
repo-main (CRLF-only difference = `core.autocrlf` translation → design must treat the Windows
install shape as its own manifest or mark it ineligible), (4) the link shapes, (5) the file set,
(6) whether any lockfile `skills` object was populated. If Developer Mode can be toggled, run the
block once with it on and once off to capture both junction and copy-fallback shapes.

## Historical rollout (superseded; do not implement)

The steps below preserve the retired write-based rollout for research context only. The
active rollout is defined in `skill-freshness-design.md` and uses read-only detection plus a
user-invoked, targeted `npx skills update <names...> --global` command; it has no ledger,
adoption flow, background updater, transactional writer, WSL reconciler, or SSH reconciler.

1. **Detection and adoption:** ship current/historical manifests, lockfile parsing, topology
   classification, destination-scoped ledger, settings states, and an explicit “Manage and
   update” action. No background writes.
2. **Local background updates:** enable adopted destinations on native macOS/Linux/Windows,
   including transaction, rollback, concurrency, and restart tests.
3. **WSL:** move the same host-side reconciler into the distro runtime and validate Linux
   semantics independently of UNC discovery.
4. **SSH:** expose the reconciler through remote runtime/RPC and validate Linux/macOS/Windows
   remote hosts, reconnects, and multiple desktop clients.

Do not advance phases based only on unit tests. Each phase needs a real-host package update,
failure injection between every transaction boundary, and proof that modified/external content
was not written.

## Implementation touchpoints

Grounded in the current codebase (verified 2026-07-12); an implementer starts here. Follow the
repo naming rule — concrete domain names, no `helpers`/`utils`.

Main process (skill engine):

- `src/main/skills/skill-discovery-sources.ts` — the approved writable-root registry lives here
  or beside it. Today it enumerates `~/.codex/skills`, `~/.agents/skills`, `~/.claude/skills`
  (sourceKind `home`) plus a Codex plugin cache (`plugin`) and repo roots. The updater must
  include only `home` roots and exclude the plugin cache and repo roots.
- `src/main/skills/discovery.ts` and `src/main/ipc/skills.ts` (`registerSkillsHandlers(store)`,
  wired in `src/main/ipc/register-core-handlers.ts`) — extend discovery to classify topology and
  provenance, and add IPC for ledger states, the adoption action, and explicit replace. The
  handler already receives the persistence `store`.
- New modules, e.g. `src/main/skills/skill-manifest.ts`, `skill-ledger.ts`, `skill-reconcile.ts`
  — manifest load, content identity (LF-normalized text / exact-byte binary), transaction
  workspace, publish/rollback.
- `src/shared/skill-metadata.ts` — existing top-level-only frontmatter parser; reuse for
  name/description in settings. It need not read a version (identity is manifest-based, not
  `metadata.version`).

State and host identity:

- `src/main/persistence.ts` (`store`, host-partitioned `orca-data.json`) — home for the
  management ledger; already host-aware and passed to the skills handler.
- `src/shared/execution-host.ts` — `ExecutionHostId = 'local' | ssh:<id> | runtime:<id>`; add a
  `wsl:<distro>` variant (none today) so ledger records key per host. Do not key off
  `src/main/git/git-capability-state.ts`: it is in-memory only and scopes SSH by provider object
  identity, which is not durable across reconnects or restarts.

Renderer and UX:

- The ~13 setting/feature surfaces that today print raw `npx skills ...` strings from
  `src/shared/agent-feature-install-commands.ts` (CliSection, OrchestrationPane, BrowserUsePane,
  EphemeralVmsPane, ComputerUseSkillSetupPanel, the linear/emulator CTAs, and the feature-wall /
  feature-tip cards) become ledger-state rows with adoption/update actions.
- `src/renderer/src/hooks/useInstalledAgentSkills.ts` — `notifyInstalledAgentSkillsChanged()` is
  the post-write refresh signal, already listened to on focus and on the install event.

Build and CI:

- `config/electron-builder.config.cjs` (+ `config/scripts/electron-builder-config.test.mjs`) —
  extraResources is already contract-tested; add `skills/` bundling and the generated manifest.
- Manifest generator, released-snapshot registry, and the monotonic-revision check run on PR and
  re-run on merge-queue / main pushes (the localization-catalog check in `pnpm lint` is the
  precedent for a generated-output gate).
- Cross-platform round trip asserts LF-normalized identity (not exact bytes) for text files and
  exact bytes for binary/executable files.

Tests:

- `tests/e2e/settings-skill-detection.spec.ts` — extend for update-available / adoption /
  conflict / rollback states.
- Keep filesystem-transaction and host-isolation coverage as deterministic integration tests
  below E2E, per the Test matrix.

### Phase 1 definition of done

Ship-ready, with no background writes, when:

- The bundled manifest and released-snapshot registry are generated and CI-verified (monotonic
  per-skill revisions, immutable history, release mapping).
- Discovery classifies every `home`-root Orca skill as current / update-available / newer-known /
  modified / unknown / externally-managed / inaccessible, using LF-normalized text identity.
- The ledger records adopted destinations in the host-partitioned store, keyed by
  `ExecutionHostId` (plus `wsl:<distro>` where applicable).
- Settings shows those states; a proactive non-repeating adoption nudge exists; "Manage and
  update" and explicit destructive replace (with backup and diff) work on the local host.
- Orca-driven installs auto-record ownership.
- No path is written in the background and no path is adopted silently.

Phase 1 exists to validate the two field assumptions before the background writer is built:
the byte/EOL identity match rate on real installs, and the adoption take-rate on the nudge.

## Test matrix

### Content and provenance

- exact current and historical official snapshot;
- edited, missing, extra, truncated, and mode-changed file;
- foreign same-name skill;
- equal revision/different content;
- newer known and unknown release;
- missing, corrupt, old-version, XDG-located, and spoofed skills CLI lock;
- lost/corrupt Orca ledger and app reinstall;
- source ref/path changes and repo/skill rename;
- supported pinned and newest skills CLI round trips match bundle identity on macOS, Linux, and
  Windows, including symlink and copy/fallback installation: exact bytes/modes for binary and
  executable files, LF-normalized content for text files;
- CRLF vs LF install (`core.autocrlf` on and off) adopts and stays managed via normalized
  identity; an EOL-only difference is never a conflict; a real content change still is;
- Orca-published text files keep the destination's existing EOL convention and do not trigger a
  skills-CLI re-update loop.
- two same-skill PRs that independently change content cannot pass the merge queue/main
  monotonicity gate with one revision;
- adoption dismissal suppresses the same destination snapshot but a newly installed official
  destination remains eligible for one proactive prompt.

### Topology

- canonical copy with provider symlinks;
- independent copy mode and Windows symlink-to-copy fallback;
- parent-directory symlink, relative/absolute skill symlink, Windows junction, hardlink, and
  case-variant alias;
- external dotfiles/chezmoi/stow target;
- Nix/Home Manager/generated and read-only roots;
- network/UNC home and long Windows paths;
- repo-scoped and plugin-cache same-name skills remain untouched;
- partial provider presence and custom provider home.

### Transactions and concurrency

- failure after stage, backup, publish, verify, ledger write, and cleanup;
- crash-orphaned staging and rollback directories are excluded from discovery, recovered or
  swept from their markers, and never offered for adoption;
- unmarked lookalike directories under or near the reserved transaction path are never swept;
- `EPERM`, `EBUSY`, disk full, permission loss, and process crash;
- two Orca windows and duplicate triggers;
- stable/dev attempts and isolated dev home;
- skills CLI or user mutation before stage, during stage, and immediately before publish;
- failed destinations retry without reprocessing successful siblings.

### Hosts and E2E

- native macOS, Linux, and Windows;
- multiple WSL distros/users, distro shutdown mid-update, and state isolation;
- SSH Linux/macOS/Windows, disconnect/reconnect mid-update, old remote runtime, two desktop
  clients, and host/user identity changes;
- settings update-available, adoption, managed-current, conflict, rollback, and retry states;
- proactive adoption nudge is non-repeating, opens review, and never claims a path by itself;
- canonical-only installs report provider visibility accurately and provider-link repair stays
  separately consented;
- post-restart app update uses the new bundle, never the pre-restart bundle.

Extend `tests/e2e/settings-skill-detection.spec.ts`, but keep filesystem transaction and
host-isolation coverage below E2E as deterministic integration tests.

## Open questions

- Exact platform paths and schema migration policy for the host-local management ledger.
- Whether the skills CLI can expose a supported machine-readable placement/ownership API in
  the future; until then its private lock remains read-only supporting evidence.
- Which custom agent homes Orca can identify from the actual launch environment rather than
  ambient desktop environment variables.
- Exact provider-link repair scope after a canonical install is managed but not visible to an
  agent; this remains separately consented from content updates.
- Toast copy and whether settings should link to a per-skill changelog.
