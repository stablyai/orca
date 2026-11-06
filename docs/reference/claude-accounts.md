# Claude accounts

Orca can keep more than one Claude account on a machine, start a session on a chosen account, and move work before a usage limit. Automatic switch, the session mover's automatic move, the auth proxy, and the account pool are off until you turn them on. The session mover's default is **ask**. On a headless host, **ask** acts as **move**, because nobody can answer a prompt.

## Accounts

`orca account add` runs `claude login` in the terminal and registers the account with the local runtime. `orca account list` prints the accounts on this machine. `--agent` defaults to `claude`. Adding a second account is a second sign-in; a private browser window keeps the first login in place.

The selected account is what a new Claude launch uses when the pool is off. System Default is the login already in `~/.claude`, not a copy Orca made.

## Usage lines

Automatic switch and the session mover share the same lines:

- 5-hour window: 95%
- weekly window: 90%
- Fable weekly window: 90%

Orca only moves or switches toward an account that has clearly more room left.

## Automatic switch

Setting: **Settings → Accounts → Claude → Switch accounts before a usage limit**. Default **off**.

```sh
orca account auto-switch --agent claude --on
orca account auto-switch --agent claude --off
```

When the selected account passes a line, the next Claude you start uses the account with the most room left. Sessions that are already running are not moved by this setting. They follow **When you switch accounts while Claude is running** (ask, always restart, or never restart), the same as a switch by hand.

`--environment <selector>` writes the setting on that paired Orca server. The server then rotates its own accounts.

## Session mover

Setting: **Settings → Accounts → Claude → Move running sessions before a usage limit**. Default **ask**.

| Value  | Desktop                                                               | Headless        |
| ------ | --------------------------------------------------------------------- | --------------- |
| `off`  | Never move a running session                                          | Never           |
| `ask`  | Show a notice. Do not move until the setting is `move`                | Treat as `move` |
| `move` | Between turns, resume the same pane on the account with the most room | Same            |

```sh
orca account session-mover --agent claude --off
orca account session-mover --agent claude --ask
orca account session-mover --agent claude --move
orca account moves
orca account moves --json
```

`orca account moves` reads `claude.sessionMoves` from the runtime that owns the sessions. Each line is the time, the pane (or the pty when the pane key is absent), from, to, the reason, and the strategy (`resume` or `proxy`). A host that predates strategies prints `-`.

A move resumes the conversation in the same pane, or keeps the process and changes the account through the auth proxy when that proxy is on. The hand-off note tells the continued session what changed: which account it left, which subagents the restart ended, and which background work was still running.

Failure: the notice names the account and the detail. A session whose account is no longer saved, or a WSL account asked to run where WSL cannot, asks you to choose another account. The mover does not invent a destination when no other account has more room.

## Auth proxy

Setting: **Settings → Accounts → Claude → Bill Claude through a local auth proxy**. Default **off**. An absent value is off. Only an explicit on turns it on.

```sh
orca account auth-proxy --agent claude --on
orca account auth-proxy --agent claude --off
orca account auth-proxy --agent claude --status
```

On: each Claude pane talks to a loopback proxy. The proxy sets the bearer for the account assigned to that pane, so a later request can use another account without restarting the process. Off: launches use `CLAUDE_CONFIG_DIR` only.

A user-set `ANTHROPIC_BASE_URL` is left unchanged. Orca does not replace that URL with the proxy, and it says so once. `--status` prints the live listener (port, slot, account, requests in the last hour, last error) and does not change the setting.

## Account pool

Setting: **Settings → Accounts → Claude → Spread sessions across accounts**. Default **off**.

```sh
orca account pool --agent claude --on
orca account pool --agent claude --off
```

On: a new Claude session starts on the signed-in account with the most room left. Off: launches use the selected account. `orca account list` shows `pool: on|off` and a session count on each account. The selected account stays what non-pooled launches and the status bar show.

## Where this is idle

| Setting          | Default | Headless         |
| ---------------- | ------- | ---------------- |
| Automatic switch | off     | off              |
| Session mover    | ask     | ask acts as move |
| Auth proxy       | off     | off              |
| Account pool     | off     | off              |
