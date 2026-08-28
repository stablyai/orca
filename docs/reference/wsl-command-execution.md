# Running commands inside WSL

Two properties of `wsl.exe` decide how every guest invocation has to be written. Both are silent
when you get them wrong: the command still runs and still exits 0, it just returns the wrong bytes.

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
