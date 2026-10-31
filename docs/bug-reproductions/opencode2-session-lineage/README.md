# Orca could not resolve OpenCode 2 session lineage (#22371 follow-up)

Orca's OpenCode plugin resolves a session's ancestry so a subagent's work rolls up to the pane
without taking it over. Against OpenCode 2 that resolution returned `null` for every session, so
every child session was published as if it were a root — and a subagent's question minted an
un-evictable "needs input" blocker the lead agent had never asked for.

Captured against the shipped `opencode v2.0.12` binary on macOS: Orca's real generated plugin in
`~/.config/opencode/plugins/orca-opencode2-status.js`, real `ORCA_PANE_KEY` / hook-token env, a
logging hook server on a loopback port, and `opencode2 --standalone` driven in a real PTY.

## The SDK shape Orca was given

`src/main/opencode2/status-plugin-setup-source.ts` handed the shared lineage walk a client built
from the plugin `setup()` context. Probing that context live inside the running plugin:

| call                                         | result                                              |
| -------------------------------------------- | --------------------------------------------------- |
| `ctx.session.get({ sessionID }, { signal })` | the session record **directly** — no `data` wrapper |
| `ctx.session.get({ path: { id } })`          | throws `Missing key at ["sessionID"]`               |
| `ctx.session.list`                           | `undefined`                                         |
| `ctx.session.get.length`                     | `1`                                                 |

`lookupSessionList` only accepts a result when `result?.data?.id === sessionID`, so every lookup
was discarded, and the `session.list` fallback it then tried does not exist. `resolveRootSessionID`
therefore returned `null` for every session and `childState` stayed permanently `null`.

## The capture

One prompt, run twice, telling the agent to delegate `echo hello-from-subagent` to exactly one
subagent. `hook-posts-before.jsonl` and `hook-posts-after.jsonl` are the verbatim hook POSTs.

Before — the subagent publishes as a root:

```
{"hook_event_name": "SessionStart", "sessionID": "ses_f33016571ffenJDTLmPcLATavv"}
{"hook_event_name": "SessionBusy",  "sessionID": "ses_f33016571ffenJDTLmPcLATavv"}
{"hook_event_name": "SessionBusy",  "sessionID": "ses_f330152d1ffer9a1SCLERqCLv8"}   <- the child
{"hook_event_name": "SessionBusy",  "sessionID": "ses_f33016571ffenJDTLmPcLATavv"}
```

`ses_f330152d1ffer9a1SCLERqCLv8` never received a `SessionStart` because the plugin skips
`session.created` events that carry a `parentID`. OpenCode's own `session_v2` row confirms it:
`parent_id = ses_f33016571ffenJDTLmPcLATavv`.

After — the child is recognised and rolls up; only the root's id is ever published:

```
{"hook_event_name": "SessionStart", "sessionID": "ses_f32f26424ffe3xdiePHBUnsdAY"}
{"hook_event_name": "SessionBusy",  "sessionID": "ses_f32f26424ffe3xdiePHBUnsdAY"}
{"hook_event_name": "SessionIdle",  "sessionID": "ses_f32f26424ffe3xdiePHBUnsdAY"}
```

The subagent still ran in the "after" capture (`ses_f32f2519dffeNSA1jG2Z8JVJyv`,
`parent_id = ses_f32f26424ffe3xdiePHBUnsdAY`); its id simply never appears in a POST.

## Reproduce

```sh
# Log POSTs on a free loopback port, then:
ORCA_PANE_KEY=tab:leaf ORCA_OPENCODE_AGENT=opencode2 \
ORCA_AGENT_HOOK_PORT=<port> ORCA_AGENT_HOOK_TOKEN=<token> \
  opencode2 --standalone --prompt '<delegate something to one subagent>'
```

Unset `ORCA_AGENT_HOOK_ENDPOINT` so the plugin reads the port/token from env instead of a live
Orca's endpoint file.

One trap: OpenCode 2 loads both `orca-opencode-status.js` and `orca-opencode2-status.js` from
`~/.config/opencode/plugins/`, and both declare the same plugin `id` (`orca-opencode-status`).
Only one survives, and if it is the v1 file its agent gate silently returns no hooks, so nothing
posts at all. Move the v1 file aside while reproducing.
