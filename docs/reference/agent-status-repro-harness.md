# Reproducing agent-status bugs

Agent status is the input to tab reveal, sleeping-session capture, and resume. Reproducing any of
those means producing a *real* status transition, and the obvious way to do it silently produces
nothing at all. This page is the delivery contract for a repro harness.

## Post the hook where the pane lives, never to the client's own port

Orca's hook endpoint (`<userData>/agent-hooks/**/endpoint.env`: `ORCA_AGENT_HOOK_PORT`,
`ORCA_AGENT_HOOK_TOKEN`, `ORCA_AGENT_HOOK_ENV`, `ORCA_AGENT_HOOK_VERSION`) answers `204` to any
correctly-signed POST, including one that will never reach the renderer.

- **POST from the client machine to the client's own port** for a pane whose PTY is remote: main
  accepts it and stores it with `connectionId: null`. `agentStatus.getSnapshot()` shows it. The
  renderer drops it, and `agentStatusByPaneKey` stays empty. `204` is not delivery.
- **POST from inside the pane's own PTY**, using the endpoint variables in that PTY's environment:
  main tags the event with the owning connection, and the status lands.

On an SSH host the pane's env carries a relay-forwarded port and `ORCA_AGENT_HOOK_ENV=remote`; read
it from the agent process (`tr '\0' '\n' < /proc/<pid>/environ`) or from the process's own
`process.env`. On a paired runtime the pane's env points at the *host's* endpoint, so the post must
run on the host and the status reaches the client through the session mirror.

The payload is the agent's own hook shape. For `claude`, `{ hook_event_name: 'UserPromptSubmit',
session_id }` starts a turn and `{ hook_event_name: 'Stop', session_id }` completes one; the
`session_id` is what becomes the resumable provider session
(`extractAgentProviderSession` in `src/shared/agent-session-resume.ts`).

## The pane has to be a real agent pane

A status for a pane Orca has no agent evidence for is dropped, whatever the hook says. Launch the
agent through the normal surface (New tab → the agent) so a launch config is registered and the
pane key is baked into the PTY env. `tests/e2e/fixtures/golden-stub-agent/golden-stub-agent.js`
works as the agent binary — put it on the execution host's `PATH` under the agent's name. It has to
be on the *execution host*: agent detection probes there, not on the client.

## Topology decides what the client is even allowed to hold

The same scenario exercises different code depending on where the pane lives, so state the topology
before quoting a result.

| | direct SSH target | paired runtime |
| --- | --- | --- |
| tab row | ordinary local row | `web-terminal-*` mirror surface |
| PTY handle | client-side | published by the host, one round trip after the rows |
| sleeping-session record | captured by the client | captured by the **host**; the client's `sleepingAgentSessionsByPaneKey` stays empty for host-owned panes |

A resume-duplication scenario cannot fire on a topology where the client holds no record, and a
pane-ownership check that refuses `web-terminal-*` ids
(`paneWillConnectOnActivation` in `src/renderer/src/lib/sleeping-agent-pane-ownership.ts`) cannot
fire on direct SSH. A zero-hit run is only evidence about the topology it ran on.
