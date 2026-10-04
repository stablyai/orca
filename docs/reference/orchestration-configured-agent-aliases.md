# Configured command aliases for orchestration workers

A worker can use the name of a direct executable configured in **Settings → Agents**.
Choose the built-in agent whose command-line interface the executable implements,
then set that agent's command override to the executable name or quoted full path.
For example, configure Codex's command as `codex-fugu`, then select it with
`orca orchestration worker-start --agent codex-fugu` and the normal placement options.

The execution host resolves its own configuration. Launch receipts use the canonical
agent (`codex` in this example), and model/effort handling reuses that agent's existing
launch rules. A receipt records applied launch preferences; it does not prove provider
entitlement, successful generation, or an arbitrary vendor's model selection behavior.

Aliases require a single executable token. Commands containing interpreter arguments,
environment assignments, or shell wrappers are not aliases. Multiple built-in agents
configured with the same executable name are ambiguous and require the canonical agent
ID. Disabled launchers remain disabled. An unconfigured name is refused even if it is
on PATH; Orca cannot infer a compatible launch interface from a process name.

The same rule applies to folder workspaces and git worktrees. For a remote worker,
configure the command on its execution host. Older hosts may refuse aliases they do not
support. Configuring a command does not create new status producers or grant permissions.
