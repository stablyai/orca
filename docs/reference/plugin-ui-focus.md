# Plugin UI focus (`ui:focus`)

How plugins learn which Orca surface is focused, what is redacted, and where
the sample is taken. This is the host half of
[chron0.discord-presence#7](https://github.com/jondmarien/orca-discord-presence/issues/7)
(“detect focused Orca window / tab in Rich Presence”). It does **not**
implement that plugin.

This surface is **experimental** and **additive inside `pluginApi` 1**.
`ui.readFocus` appears in minor `1.2`. It is **off by default**: a plugin
does not receive focus data unless the user consents to the `ui:focus`
capability.

## Why a capability

Tab titles, file names, page URLs, and worktree ids are identifying.
`workspace:read` already exposes the focused worktree's display name, branch,
and terminal **ids** — not which pane is active. Event subscriptions do not
re-fingerprint consent, so adding `ui.focus.changed` to the allowlist alone
would leak titles to any already-approved `events:subscribe` plugin.

`ui:focus` is the opt-in. Installing or updating a plugin that declares it
re-prompts consent.

## What plugins receive

One privacy-safe projection, delivered three ways:

```ts
type PluginFocusedSurface = {
  kind: 'terminal' | 'agent' | 'browser' | 'editor' | 'simulator' | 'command-palette'
  title: string | null
  worktreeId?: string | null
  agentId?: string | null
}

type PluginUiFocusChangedPayload = {
  focusedSurface: PluginFocusedSurface | null
  receivedAt: number
}
```

| Delivery | When | Notes |
|---|---|---|
| `ui.focus.changed` | Projected snapshot **changes** | `{ focusedSurface, receivedAt }`. Requires `events:subscribe` **and** `ui:focus`. Manifests that list the event without `ui:focus` fail validation. |
| `ui.readFocus` | Plugin polls | `{ focusedSurface }`. Requires `ui:focus`. Panel-callable. `since: '1.2'`. |
| `workspace.readContext` | Plugin reads workspace context | `focusedSurface` is **present only** with `ui:focus`; omitted otherwise so old `{ branch, displayName, terminals }` callers stay valid. |

`focusedSurface` is `null` when focus is unknown or the Orca window is
unfocused. Missing/`null` focus must not clear other presence — that is the
plugin's job.

### Field contract

| Field | Required | Privacy |
|---|---|---|
| `kind` | yes, when a surface exists | Coarse label only |
| `title` | nullable | Never a filesystem path or full URL. Path-like values become a basename; `http(s)` titles become a hostname; then truncated to 80 UTF-8 bytes |
| `worktreeId` | optional | **Session-scoped opaque token** when the host id embeds a path (`${repoId}::${path}` or any `/` `\`). Stable for the host process so successive focus events for the same worktree match each other. Not a filesystem path. Do **not** display it. It is not necessarily equal to `worktree.created` / `agent.status.changed.worktreeId` (those events still use the host id). Non-path ids such as `wt-1` pass through. Omit/`null` when unknown. `workspace.readContext` still has **no** top-level `worktreeId` |
| `agentId` | optional, only when `kind === 'agent'` | Focused agent-session **tab id**. `agent.status.changed.paneKey` is `${tabId}:${leafId}` — join with `paneKey.startsWith(agentId + ':')`. Not a model name, session path, or agent profile |

There is no `path`, URL, hostname, or model field on this surface. Agent
type / model / profile stay on `workspace.readContext.agent` and
`agent.status.changed.agent` (Orca-3).

## Default off

| Gate | Effect |
|---|---|
| User did not grant `ui:focus` | `focusedSurface` omitted from `readContext`; `ui.readFocus` is `capability_denied`; `ui.focus.changed` is not delivered; `events.subscribe` drops that name |
| Window unfocused / no sample yet | `focusedSurface: null`. Missing focus must not clear other presence |
| Plugin toggle / detail level | Host does not interpret Discord detail levels. Plugins must keep their own default-off display toggle |

## Where focus is sampled (remote UI)

Focus lives on the **UI machine**. Plugin workers run on the **Orca host**
(including `orca serve` and SSH workspaces — plugins still execute on the
computer running the host). See
[ssh-execution-boundary.md](./ssh-execution-boundary.md): the execution host
owns execution; the UI machine owns chrome.

```
UI renderer (Windows / macOS / Linux client)
  ├─ plugins:reportUiFocus IPC                 local Electron host
  └─ plugins.reportUiFocus runtime RPC         paired client → runtime host
        → PluginUiFocusSnapshot.apply          host re-projects
        → ui.focus.changed                     workers on the host
        → workspace.readContext / ui.readFocus
```

| Topology | Who samples | How it reaches the host |
|---|---|---|
| Local Electron | Renderer (tab type, active tab label, Cmd+J / Quick Open) plus main `browser-window-blur` | `plugins:reportUiFocus` IPC |
| Remote UI (paired client → host), e.g. Windows controlling an Omarchy / Linux `orca serve` | The **UI client's** renderer | `plugins.reportUiFocus` runtime RPC (new method; no protocol-version bump). Older hosts reject the call; the client ignores that |
| Headless host, no UI | Nobody | Snapshot stays `null` until a paired client reports |

Loss of contact is not evidence the UI closed a surface. An unreported or
unverifiable focus is `null`, not a guessed kind.

The host re-projects every report. Renderers may send a raw title and join
keys; the snapshot stored for plugins always uses the sanitized title.

Discord IPC on another box is a **later** hop (sidecar / companion — see
[plugin-sidecar-remote-presence.md](./plugin-sidecar-remote-presence.md) and
#3 / #6). This API only gets focus onto the host where plugins run.

## Debounce expectations for consumers

- Renderer coalesces reports (~100ms) before IPC/RPC
- Host emits `ui.focus.changed` only when the **projected** snapshot changes
  (kind, title, `worktreeId`, or `agentId`)
- Discord `SET_ACTIVITY` is ~15s; plugins must still coalesce focus spam
- Seed with `ui.readFocus` or `workspace.readContext` after subscribe — do
  not wait for the first event
- Treat `focusedSurface` / `ui.readFocus` as optional on older hosts

## Plugin author notes

```js
// orca-plugin.json
{
  "pluginApi": 1,
  "capabilities": [
    { "kind": "workspace:read" },
    { "kind": "events:subscribe" },
    { "kind": "ui:focus" }
  ],
  "contributes": {
    "events": [{ "on": "ui.focus.changed" }]
  }
}
```

```js
orca.events.on('ui.focus.changed', (payload) => {
  // payload.focusedSurface is { kind, title, worktreeId?, agentId? } or null
})

const focus = await orca.host.call('ui.readFocus', {})
// focus.focusedSurface — requires ui:focus; unknown method on pre-1.2 hosts

const context = await orca.host.call('workspace.readContext', {})
// context.focusedSurface is present only with ui:focus
```

Related: [orca-discord-presence#7](https://github.com/jondmarien/orca-discord-presence/issues/7),
[orca-discord-presence#10](https://github.com/jondmarien/orca-discord-presence/issues/10) Orca-4,
[remote-wire-compatibility.md](./remote-wire-compatibility.md),
[ssh-execution-boundary.md](./ssh-execution-boundary.md).
