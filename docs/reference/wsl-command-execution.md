# Running commands inside WSL

Two properties of `wsl.exe` decide how every guest invocation has to be written. Both are silent
when you get them wrong: the command still runs and still exits 0, it just returns the wrong bytes.
Those are sections 1 and 2. A closing section answers the question that running Orca's writes
inside a distro raises next: what happens to the distro's disk image.

## 1. Always `--exec`, never `--`

`wsl.exe -d <distro> -- <argv>` expands `$name` in **every argument** against the guest environment
before the guest runs. This is `wsl.exe` itself, not the guest shell — it happens with no shell in
the command at all:

```
$ wsl.exe -d Ubuntu-24.04 --      /usr/bin/printf %s '$HOME'
/home/you
$ wsl.exe -d Ubuntu-24.04 --exec  /usr/bin/printf %s '$HOME'
$HOME
```

So under `--`, a script means something other than what it says. `awk '{print $2}'` reaches the
guest as `awk '{print }'` and prints the whole line; a positional `"$1"`, a shell local, and a
`"\$literal"` are blanked or rewritten the same way. (Expansions with no `$` are unaffected — a
`sed` backreference like `s/(a)(b)/\2\1/` survives either way.) Escaping `$` on the Windows side
cannot fix this reliably — an earlier attempt skipped every `$` preceded by a backslash, which is
exactly the case a POSIX script uses to mean a literal dollar.

Build argv with `buildWslExecArgs()` in `src/shared/wsl-login-shell-command.ts`. A test walks the
tree and fails if the `--` form reappears.

The `--` inside `sh -s -- <path>` is a _shell_ argument separator and is unrelated; leave it alone.

## 2. Machine-read output must be fenced

Orca runs guest commands through the distro user's **interactive** login shell (`-ilc` for
bash/zsh) because that is the only shell that reads `~/.bashrc`, where `nvm`, `mise` and `asdf`
install their PATH entries. Dropping `-i` would break tool detection for those users.

The cost is that an interactive shell also runs the distro's rc/motd, and that output goes to
**stdout** — the same stream the answer arrives on. Stock Ubuntu 24.04 needs no customization to
reproduce it:

```
$ wsl.exe -d Ubuntu-24.04 --exec bash -ilc 'git --version'
To run a command as administrator (user "root"), use "sudo <command>".
See "man sudo_root" for details.

git version 2.43.0
```

Any caller that parses stdout must use `buildWslCapturedLoginShellCommand()`, which fences the
payload and returns a matching `readStdout`. `.trim()` does not help: the banner is a prefix, not
surrounding whitespace, so a stat probe compared against `"directory"` simply never matches.

The fence carries a per-call nonce so that `cat`-ing a file whose contents happen to quote a marker
is not truncated, and it preserves the payload's exit status so `exit 2` → `ENOENT` mappings keep
working.

**Do not fence a command that `exec`s into a long-running program** (`codex app-server`, an
interactive terminal). It never reaches the closing fence, and there the shell's own output either
belongs to the program or is what the user wants to see.

## Prefer no shell at all

When a caller only needs a known binary with a known environment, skip the login shell entirely and
run the binary directly:

```
wsl.exe -d <distro> --exec /usr/bin/env PATH=… HOME=… /usr/bin/git -C <dir> status
```

This is what the direct-git read path does. It is immune to both problems above by construction and
avoids paying login-shell startup on every call, which also sidesteps profiles that block or print.
Resolve the PATH/HOME once through a fenced probe, cache it per distro, then use this form.

## Disk: the distro VHDX only grows

Everything above puts Orca's writes inside the distro, which raises a separate question. WSL2 keeps
the entire guest filesystem in a single dynamically-expanding `ext4.vhdx`. Deleting files inside
the distro does free the blocks — for ext4 to reuse — but the host-visible `.vhdx` does not shrink
on its own.

### Finding the file

The path depends on how the distro was installed, so do not assume one:

| Install method         | `ext4.vhdx` lives under                                   |
| ---------------------- | --------------------------------------------------------- |
| recent `wsl --install` | `%LOCALAPPDATA%\wsl\{guid}\`                              |
| Microsoft Store        | `%LOCALAPPDATA%\Packages\<PackageFamilyName>\LocalState\` |
| `wsl --import`         | wherever the operator pointed it                          |

The install-agnostic answer is the registry, which records every distro's directory as `BasePath`:

```powershell
Get-ChildItem HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss |
  ForEach-Object { Get-ItemProperty $_.PSPath } |
  Select-Object DistributionName, BasePath
```

### Measured behavior

WSL 2.7.11.0 / Ubuntu-24.04, one machine. Sizes are **size on disk** — allocated bytes, via
`GetCompressedFileSize`, not the logical file length. That distinction matters below: on this
machine the vhdx was not sparse, so the two numbers were identical, but on a sparse vhdx the
logical size stays pinned at the high-water mark while only size on disk falls when space is
reclaimed. Measure the wrong one and reclaim looks like it did nothing.

| Step                               | `ext4.vhdx` size on disk (bytes) |
| ---------------------------------- | -------------------------------- |
| baseline                           | 21,673,017,344                   |
| write 1 GiB                        | 22,746,759,168                   |
| delete it                          | 22,746,759,168                   |
| write a fresh incompressible 1 GiB | 22,746,759,168                   |
| hold 3 GiB live at once            | 24,894,242,816                   |

The fourth row is the point: the second gigabyte cost zero growth, because ext4 handed it the
blocks the first one freed. Only exceeding the previous peak moved the file.

### Reclaiming space

Sparse mode lets the guest hand freed blocks back to the host, so the file can shrink instead of
only growing. Two preconditions, both easy to miss: the distro has to be stopped (the vhdx cannot
be converted while it is mounted), and `wsl --manage` exists only on WSL 2.5 and newer — check with
`wsl --version`.

```
wsl --terminate <distro>
wsl --manage <distro> --set-sparse true
```

The equivalent for distros not yet created is `sparseVhd = true` under `[experimental]` in
`%UserProfile%\.wslconfig` — that file lives in the Windows user profile, **not** inside the distro
and not at `~/.wslconfig`, and does not exist until you create it.

Neither touches slack that already exists. For that, shut WSL down and compact the file by hand
from an **elevated** prompt. `compact vdisk` on its own fails because no virtual disk is selected,
so the `select` and the read-only `attach` are required, not optional:

```
wsl --shutdown
diskpart
DISKPART> select vdisk file="C:\path\to\ext4.vhdx"
DISKPART> attach vdisk readonly
DISKPART> compact vdisk
DISKPART> detach vdisk
DISKPART> exit
```

Two caveats, neither verified here: field reports say `compact vdisk` is a no-op on a vhdx that is
already sparse (convert back with `--set-sparse false` first), and sparse mode's runtime cost was
not measured. Microsoft's [disk-space guide](https://learn.microsoft.com/windows/wsl/disk-space)
carries the current locate/expand/compact procedure and the `--manage` version floor;
[`.wslconfig`](https://learn.microsoft.com/windows/wsl/wsl-config) carries `sparseVhd`. Enabling
sparse mode and compacting are both per-machine decisions; Orca does not make either.

On the measured machine the vhdx was **not** sparse: `fsutil sparse queryflag` reported "NOT set as
sparse", and no `%UserProfile%\.wslconfig` existed to opt in. Microsoft documents `sparseVhd` as
defaulting to `false`, so that is the expected state rather than a local quirk — but the flag is
per-vhdx, set when the disk is created or by an explicit conversion, so check your own distro
rather than assuming either way.

### What this means for Orca

A vhdx that grows as speculative worktree preparation and mirrored worktrees write into the distro
is expected. Its size is monotonically non-decreasing and roughly tracks peak concurrent usage —
but it can drift above peak, and the measurement above is the best case for reuse: the second
gigabyte was allocated immediately after the first was freed, out of the same block group. Under
sustained churn — many worktrees created and removed over weeks, no `fstrim`/discard, sparse off —
allocation spreads and the file settles higher than live peak.

So growth on its own is not evidence of a leak. Growth well above live peak usage is worth
investigating, and is the case the reclaim steps above address.
