# Claude accounts

Orca can keep more than one Claude login and choose which one a new session uses. Switching is off until you turn it on.

## Registry

Each live Claude pane records the managed account it was launched on. The record names the pane, the account, and the folder the session runs in. When the pane closes, the record goes away. `accounts.list` includes `paneAccounts` and `assignedSessions` for the panes that are open.

A status-line reading from a pane is attributed to that pane's account, so usage stays with the login that produced it.

## Automatic switching

`claudeAutoSwitchEnabled` defaults to false. When it is on, and the selected account passes 95% of its 5-hour window or 90% of its weekly window, Orca selects the managed account with the most room left. The next Claude session starts on that account. A desktop notification says which account took over, and running sessions get the same restart question as a switch you make by hand.

On a machine with no window (`orca serve`), usage is polled only while automatic switching is on. Turning it off stops that poll.

```bash
orca account auto-switch --agent claude --on
orca account auto-switch --agent claude --off
orca account auto-switch --agent claude --on --environment <server>
```

`--environment` writes the setting on that paired server. The other `orca account` commands stay on this machine.

A launch can also name one saved host account. An unknown id or a WSL account fails before the process starts, and the chat says which.
