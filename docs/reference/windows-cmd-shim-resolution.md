# Resolving Windows `.cmd` shims past cmd.exe

Node refuses to spawn a `.cmd`/`.bat` target without a shell (the
CVE-2024-27980 mitigation), so `resolveSpawn` has to make `cmd.exe` the program
and hand it `/d /v:off /s /c "<caret-escaped argv>"`. For an agent CLI that
means a long `cmd.exe /c` line whose caret-escaped payload is natural-language
prompt text — which Microsoft Defender for Endpoint's command-line model scores
as obfuscation. `codex.cmd` appeared in the spawn cluster of an MDE incident
against Orca for exactly this reason.

`src/shared/child-process/windows-cmd-shim-resolution.ts` sidesteps it. npm's
`cmd-shim` and pnpm's `@zkochan/cmd-shim` generate files whose entire body is
"find a Node interpreter and run this script". Reading one lets `resolveSpawn`
spawn `node.exe <script> <args…>` directly: no cmd.exe in the tree, and no
caret escaping at all.

## What resolution changes

Only `runProcess` / `spawnProcess` callers. Two things people expect it to
cover, and it does not:

- **The interactive terminal.** `src/main/daemon/pty-subprocess/native-pty-spawn.ts`
  calls `pty.spawn` directly, so typing `codex` in an Orca terminal is
  completely unaffected.
- **Orca's own hook wrappers** (`codex-hook.cmd` and friends). These are batch
  files Orca writes, matching none of the generator shapes, so they keep the
  cmd.exe path. They are addressable — we generate them — but not by this
  module.

## Adding a shape

Four shapes are recognised, each transcribed verbatim from a real install into
`src/shared/child-process/__fixtures__/windows-cmd-shim-bodies.ts`. If you add a
fifth, add its real body there too. A shape guessed from documentation is not
evidence.

The rule for the parser is all-or-nothing: the whole canonicalised body must
match end to end, and anything unrecognised returns null and keeps the cmd.exe
path. **A mis-resolution silently runs the wrong program or drops arguments,
which is far worse than an EDR alert** — when in doubt, refuse.

Resolution also refuses a captured path that is absolute, drive-relative
(`D:evil.js` — `win32.isAbsolute` says false, but `win32.resolve` leaves the
shim directory), or contains `% ^ & | < > " :` or a line break; a script or
target that is not on disk; an interpreter-less target that is not `.exe`/`.com`;
and a program path that is not absolute.

Refusing every `:` cannot cause a false refusal. Windows reserves the character
within a path segment, so a relative path cannot contain one — the only
spellings that can are drive-qualified, an alternate data stream (`a.js:zone`),
or a `\\?\` device path, and the last is already refused as absolute.

## Kill switch

Set **`ORCA_DISABLE_CMD_SHIM_RESOLUTION`** to any non-empty value in the
environment a child is spawned with, and every `.cmd` goes back through
`cmd.exe /c` unchanged. It is read from the spawn's own environment, so
exporting it before launching Orca disables resolution process-wide.

Use it to confirm a suspected mis-resolution: run the failing operation with and
without it. Identical behaviour means resolution is not the cause. If it is,
report the shim's body — the parser is only allowed to recognise shapes we have
seen for real.

## Behaviour that changes, deliberately

A resolved shim is not merely a quieter spelling of the cmd.exe path. Two limits
of `cmd.exe` disappear with it:

- An argument containing `\r`/`\n` was rejected outright, because cmd ends its
  command at a raw line break whatever the quote state. Multi-line agent prompts
  now work.
- A command line over 8191 characters returned `The command line is too long.`
  Long prompts now work.

Both are improvements, but they are behaviour changes: an unresolved shim still
hits both limits, so a caller must not assume every `.cmd` accepts them.
