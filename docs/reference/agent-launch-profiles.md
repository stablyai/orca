# Agent launch profiles

A launch profile pins **one launch** of a CLI agent to a credential home and/or process-local
overrides. Selection is per launch, never a global slot, so two panes on the same host can run
the same agent under different accounts or model providers at the same time.

This is orthogonal to managed accounts. A managed account is a credential Orca captured and
stores; a launch profile decides where a particular launch reads its credentials from and which
extra args/env it carries. A plain launch (no profile) behaves exactly as before.

## Profiles

| Profile                                 | Agent  | What it does                                                                                                                                                                                                                      |
| --------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex-secondary-home` (built-in)       | codex  | Runs Codex with `CODEX_HOME=~/.codex-2` (or `$ORCA_CODEX_SECONDARY_HOME`). Log in there once with `CODEX_HOME=~/.codex-2 codex login`.                                                                                            |
| `claude-secondary-home` (built-in)      | claude | Runs Claude Code with `CLAUDE_CONFIG_DIR=~/.claude-2` (or `$ORCA_CLAUDE_SECONDARY_HOME`). Log in there once with `CLAUDE_CONFIG_DIR=~/.claude-2 claude auth login`.                                                               |
| custom (`settings.agentLaunchProfiles`) | any    | Appends `args` after the agent's configured args and merges `env` over the agent's default env. Use this for an OpenAI-compatible or Anthropic-compatible provider (`-c model_provider=...`, `ANTHROPIC_BASE_URL`, key env vars). |

Custom rows are plain settings, like `agentDefaultArgs` / `agentDefaultEnv`:

```json
{
  "agentLaunchProfiles": [
    {
      "id": "codex-work-proxy",
      "agent": "codex",
      "label": "Codex · work proxy",
      "args": "-c model_provider=\"work\" -c model_providers.work.base_url=\"https://llm.example.com/v1\" -c model_providers.work.env_key=\"WORK_API_KEY\"",
      "env": { "WORK_API_KEY": "..." }
    }
  ]
}
```

Ids are lowercase slugs; built-in ids cannot be shadowed. `args` is tokenized for the launch
shell the same way `agentDefaultArgs` is, so quoting rules do not change per profile.

## How a launch travels

```
client picks a profile ──► terminal.createAgentSession { agent, launchProfileId }
                           (or session.tabs.createTerminal / worktree.create startupLaunchProfileId)
host validates the id against its own catalog
host layers args/env and stamps ORCA_AGENT_LAUNCH_PROFILE=<id>
secondary-home profiles also stamp a marker: ORCA_CODEX_HOME_PROFILE / ORCA_CLAUDE_CONFIG_DIR_PROFILE
execution host (daemon spawn) turns the marker into the real path — host: ~/.codex-2, WSL: <distro home>/.codex-2
```

Only the execution host ever knows the real path. The runtime never sends a path to a client and a
client never sends one to the host.

Named errors from the host: `agent_session_launch_profile_unknown`,
`agent_session_launch_profile_agent_mismatch`, `agent_session_launch_profile_remote_unsupported`
(raised at spawn when an SSH session never learned the remote home a secondary home needs).

On SSH hosts the env reaches the relay as a literal map, so the secondary home is joined from
the home directory the session probed at connect time, in the remote's path flavor. The
remote's own `ORCA_*_SECONDARY_HOME` override is not consulted there.

## What changes for the managed-account machinery

- A Codex launch carrying the Codex marker skips managed-home selection and the managed-auth
  wait, drops the managed-home hook preflight, and is recorded in `codex-pane-accounts.json` as
  `homeRoute: 'custom-home'` with `launchProfileId`, so stale-account prompts never name it.
- A Claude launch carrying the Claude marker skips the managed credential materialization into
  `~/.claude` and its auth-env stripping, because the launch reads a different directory.

## Surfaces

- Desktop tab bar: the agent row becomes a submenu when profiles exist (`Default launch` +
  one item per profile).
- Paired web / thin clients: `launchProfileId` rides `terminal.createAgentSession`; hosts
  advertise `agent-session.launch-profile.v1`, and the client refuses to fall back to the legacy
  env-only create on hosts that lack it.
- CLI: `orca worktree create --agent codex --launch-profile codex-secondary-home`.
- New Workspace composer: a `Launch profile` select appears under the agent picker when the
  chosen agent has profiles; the profile is layered into the startup command and env the
  renderer already sends, so no new create field is needed.
- Mobile: the new-tab sheet lists each agent's profiles beneath its default launch once the
  host advertises the capability, and a terminal tab shows a small badge with the profile it
  runs under (built-ins shortened, custom ids as-is).
