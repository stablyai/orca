# Which device last typed into a pane

An agent hook only sees the environment it was launched with (`ORCA_PANE_KEY`,
`ORCA_AGENT_HOOK_PORT`, `ORCA_AGENT_HOOK_TOKEN`, ...). None of that changes when the user
switches from the desktop to a paired laptop or phone. The hook listener answers one read
route so a hook can find out where the last input to its pane came from.

## Route

```
GET /pane/<paneKey>/last-input
X-Orca-Agent-Hook-Token: <ORCA_AGENT_HOOK_TOKEN>
```

`<paneKey>` is `ORCA_PANE_KEY`, raw or percent-encoded. Same loopback bind and token as the
`POST /hook/<agent>` routes; every other `GET` still returns `404` without any token check.

| Status | Meaning                                                                          |
| ------ | -------------------------------------------------------------------------------- |
| `200`  | JSON body below.                                                                 |
| `204`  | This host owns the pane, but nothing has been typed into it since it was opened. |
| `404`  | Unknown pane, malformed pane key, or a host that does not serve the route.       |
| `403`  | Missing or wrong hook token.                                                     |
| `500`  | The host's resolver threw; the listener stays up.                                |

```json
{
  "pairedDeviceId": "a46d3651-...",
  "deviceName": "book-257c7tqdg8",
  "clientKind": "runtime",
  "at": 1789999999999
}
```

- `clientKind` is `mobile` or `runtime` for a paired websocket client, and `local` for input
  from this machine: the desktop renderer, or the CLI over the unix socket.
- `pairedDeviceId` and `deviceName` are `null` for `local`. `deviceName` is resolved from the
  pairing registry at read time, so a renamed device shows its new name.
- `at` is the time the PTY accepted the write, in milliseconds since the epoch.

## Example hook

```sh
# UserPromptSubmit
curl -s -H "X-Orca-Agent-Hook-Token: $ORCA_AGENT_HOOK_TOKEN" \
  "http://127.0.0.1:$ORCA_AGENT_HOOK_PORT/pane/$ORCA_PANE_KEY/last-input" \
| jq -r 'select(.clientKind) | "[orca] input from: \(.deviceName // .clientKind)"'
```

## What is recorded

The runtime keeps one record per PTY and overwrites it once a write from `terminal.send`,
`terminal.multiplex` input frames, legacy `terminal.subscribe` input frames, or the desktop
renderer's own keystrokes has been accepted in full; a paste refused part-way records nothing. Writes the runtime makes on its own behalf
(orchestration dispatch, worker preambles) do not change it. The record is dropped when the
PTY exits or the provider generation resets, so a reused PTY id never reports a previous
process's writer.

## Trust boundary

The hook token is one per Orca process, shared by every agent pane on that host. Any holder
can read any pane's record here, the same way it can already post status for any pane. The
record carries only the device id, its display name (already shown in the UI) and a timestamp.

For an SSH worktree the hook runs on the remote host and talks to the relay listener there,
which does not serve this route; such a hook gets `404`.
