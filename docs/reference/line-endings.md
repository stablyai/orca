# Why every file in this repo is LF

## The short version

`.gitattributes` starts with one line:

```
* text=auto eol=lf
```

That means Git stores every text file with LF **and** writes it to disk with LF, on
macOS, Linux and Windows alike. One file is deliberately checked out with CRLF —
the Windows CLI shim, [below](#the-one-crlf-exception). Everything else is LF.

## What this fixes

Git for Windows ships with `core.autocrlf=true`. On a stock Windows clone Git used to
rewrite the working tree on the way out, and Orca ships executable shell scripts
straight out of this repo — so that rewrite reached users, not just contributors:

| File | Ships as | Before (Windows clone) | After |
| --- | --- | --- | --- |
| `resources/linux/bin/orca-ide` | the Linux `orca-ide` command | `env: bash\r: No such file or directory`, exit 127 — the script never runs | runs |
| `resources/darwin/bin/orca` | the macOS `orca` command | same | runs |
| `resources/linux/packaging/after-install.sh` | deb/rpm post-install hook | same | runs |
| `.husky/pre-commit` | the commit hook | same | runs |

The contributor-facing half was the visible symptom (`pnpm lint` could not pass on a
fresh Windows clone, because generated-artifact checks compare bytes and the checkout
had `\r\n` where the generator emits `\n`), but the shipped scripts were the real cost.

## Why it did not rewrite anything

`text=auto` leaves the binary/text decision to Git, and the repository was already
LF-only — every blob in the index, all 20,050 of them, was unchanged by
`git add --renormalize .`. The policy pins existing behaviour; it does not convert
files. That is what makes it safe to apply in one commit.

## If you already have a Windows clone

Changing `.gitattributes` does not rewrite files already on disk — `git pull` leaves a
CRLF working tree exactly as it was, because the blobs did not change. Repair it once:

```
git rm --cached -r .
git reset --hard
```

A fresh clone needs nothing.

## The one CRLF exception

`resources/win32/bin/orca.cmd` is pinned the other way:

```
/resources/win32/bin/orca.cmd text eol=crlf
```

This is not a hygiene lapse. It is the byte that already ships. The release Windows
runner pins nothing and sets no `core.autocrlf`, so it converted this file on checkout
long before the blanket rule existed:

| | committed blob | inside v1.4.192's `orca-windows-setup.exe` |
| --- | ---: | ---: |
| size | 644 B | 665 B |
| CR | 0 | 21 |

665 − 644 = 21, exactly the file's line count — the same bytes with every `\n` doubled.
The same installer carries its own control: the seven files under `resources/plugins/`
were already pinned to LF and shipped unconverted, byte-identical to their blobs. One
artifact, both directions.

So the pin **reproduces** today's shipped launcher rather than changing it, and makes it
deterministic instead of dependent on a runner-image default nobody controls. Leaving
the file to the blanket rule is what would flip a shipped byte — on a batch file that
uses `goto` with labels, into an encoding no smoke test executes
(`config/scripts/smoke-packaged-cli.mjs` resolves the packaged CLI to
`resources/bin/orca.exe` on win32, never the `.cmd` beside it).

Whether LF actually *breaks* `cmd.exe` here is measured, not assumed —
`config/scripts/check-windows-launcher-line-endings.ps1` runs the shim both ways on
`windows-2022` and reports which. The pin stands either way, because reproducing the
shipped bytes is the point.

The pin changes the working tree only. The stored blob stays LF, so
`git add --renormalize` still stages nothing:

```
$ git ls-files --eol -- resources/win32/bin/orca.cmd
i/lf    w/crlf  attr/text eol=crlf      resources/win32/bin/orca.cmd
```

## The three exemptions

- `config/patches/*.patch` are `-text`: pnpm hashes each patch byte-for-byte, so any
  normalization breaks `pnpm install`.
- `config/patches/@xterm__xterm@*.patch` are `-diff`: the bundle hunks are unreadable in
  a diff. Review `config/patches/xterm-src/` instead.
- `src/main/__fixtures__/shell-wrapper-snapshots/*.txt` are `linguist-generated`, so they
  collapse in a PR diff. They are still diffable — the shell diff is the review surface.

## What keeps it true

`pnpm lint` runs `config/scripts/check-line-ending-policy.mjs`. For every tracked file
that the OS has to execute — anything starting with `#!`, plus anything carrying the
executable bit, 132 files today — it asserts both halves independently:

1. the **committed blob** contains no CRLF (what ships, on every platform), and
2. `git check-attr eol` resolves to `lf` (what a `core.autocrlf=true` clone writes).

Neither implies the other: a clean blob still breaks Windows under a stray `eol=crlf`,
and a correct attribute still ships CRLF if the blob itself carries it.

The same script asserts the CRLF exception with the mirrored rules — the blob must
still be LF, and `eol` must resolve to `crlf` — so the exception cannot be silently
reclaimed by the blanket rule or quietly widened. On Windows,
`check-windows-launcher-line-endings.ps1` adds the empirical half: it reads
`git ls-files --eol` to confirm the runner really wrote CRLF, then executes the shim's
guard path and its fall-through under a real `cmd.exe`.

The population is derived from file content, not hand-listed. A curated list would have
had to name 122 files on the day this landed and would silently miss the 123rd — which
is exactly how the broken launcher shipped. Equally, the gate is not a repo-wide "no
CRLF anywhere" rule: that would over-fire on the byte-pinned pnpm patches. There is no
exemption list, because CRLF is never correct for a file the OS has to exec.
