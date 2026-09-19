# OMP startup keyboard capability query

OMP's ProcessTerminal sends `CSI ? u` and then a DA1 sentinel before selecting its keyboard encoding. A fresh desktop terminal already advertises Kitty support, but a direct New Tab launch can query before that renderer owns replies. Previously startup ingress answered only OSC color queries.

The renderer now supplies optional `terminalKittyKeyboardProtocol: true` from its actual xterm `vtExtensions.kittyKeyboard` setting. The existing local/SSH/paired spawn route places it in startup ingress as optional `kittyKeyboardProtocol`. Missing or false capability leaves behavior unchanged, including panes that deliberately withhold Kitty on native Windows. The ingress version and stream opcodes do not change. Terminal creation accepts additive fields, but host-authoritative `terminal.createAgentSession` and `terminal.ensureAgentSession` use strict schemas. Clients send the keyboard flag on those methods only after the host advertises `agent-session.keyboard.v1`. The negotiated payload stays fixed across launch retries; old hosts receive the original payload and retain the renderer fallback. New hosts accept older clients that omit the flag. Paired background launches use the same negotiated support and default paired-terminal advertisement; legacy terminal creation receives the additive flag.

Source ingress answers only the exact first `CSI ? u` before its deadline/renderer handoff. It uses the existing mode tracker for preceding flag pushes and the existing reply-delivery echo guard. Its transformed source span consumes the query once, while the following DA1 and Kitty mode-setting bytes retain their sequence ranges and reach the renderer. Keyboard intent does not require theme colors. Color and Kitty authority end independently: answering both colors does not end Kitty handling, and ConPTY's persistent color ownership does not retain Kitty ownership after handoff.

Run the actual OMP protocol smoke with a read-only reference checkout:

```sh
ORCA_BACKGROUND_LAUNCH=1 bun tests/tools/omp-startup-keyboard-smoke.mjs /path/to/oh-my-pi > /tmp/omp-startup-keyboard.json
```

This uses OMP's real ProcessTerminal with intercepted process-local stdin/stdout, a disposable HOME, and no model call. It verifies negotiation before any renderer attaches, a single reply, preserved mode push, and contiguous raw sequence coverage. It does not constitute live Windows/SSH or rendered shortcut proof.
