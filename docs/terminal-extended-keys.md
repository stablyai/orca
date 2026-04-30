# Extended Key Chords in the Terminal (Shift+Enter, etc.)

## What Orca sends

Orca's built‑in terminal already encodes extended key chords using the
[kitty keyboard protocol][kitty] (CSI‑u). For example, **Shift+Enter** is sent
as the byte sequence:

```
ESC [ 1 3 ; 2 u      (i.e. \x1b[13;2u)
```

See `src/renderer/src/components/terminal-pane/terminal-shortcut-policy.ts`
for the full table.

Orca also advertises kitty‑protocol support to the running program via
`vtExtensions.kittyKeyboard` on xterm.js (see
`src/renderer/src/lib/pane-manager/pane-terminal-options.ts`), so CLIs that
probe with `CSI ? u` learn that the terminal speaks CSI‑u and enable their
enhanced input handlers.

## Why Shift+Enter may not reach your CLI inside tmux

tmux, by default, strips both extended‑key encodings (modifyOtherKeys
`CSI 27 ; 2 ; 13 ~` *and* kitty‑style `CSI 13 ; 2 u`). If you run Claude
Code, Codex, or any other CLI under tmux, Shift+Enter will look like a
plain `Enter` unless tmux is told to pass those bytes through.

Add this to `~/.tmux.conf` (tmux 3.2+):

```tmux
set -s extended-keys on
set -as terminal-features 'xterm*:extkeys'
```

Then reload: `tmux source-file ~/.tmux.conf` (or restart the tmux server).

- `extended-keys on` — tell tmux to accept and forward the extended
  encodings instead of collapsing them to the unshifted key.
- `terminal-features 'xterm*:extkeys'` — tell tmux that the surrounding
  terminal (Orca, in this case) understands those encodings, so tmux is
  willing to emit them.

## Verifying end‑to‑end

Inside an Orca terminal (no tmux), run:

```
cat -v
```

Press **Shift+Enter**. You should see:

```
^[[13;2u
```

That's caret notation for `\x1b[13;2u` — the expected CSI‑u encoding. If
you see `^M` (or a blank newline) instead, either the chord isn't reaching
the terminal (check `keyboard-handlers.ts` / `terminal-shortcut-policy.ts`)
or you're inside tmux without the config above.

Inside tmux after the config, the same `cat -v` test should print the same
`^[[13;2u`.

[kitty]: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
