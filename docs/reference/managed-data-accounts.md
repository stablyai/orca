# Managed OpenCode and Devin accounts

Run enrollment in a terminal on the machine running Orca:

```sh
orca account add --agent opencode --label Work
orca account add --agent opencode --integration opencode-go --label Work
orca account add --agent devin --label Work
orca account list --agent opencode --json
orca account select --agent opencode --account <id>
orca account select --agent opencode --account system
orca account rm --agent opencode --account <id>
```

OpenCode enrollment requires OpenCode 2 and runs its official `auth login --standalone` command. Devin runs `auth login --force-manual-token-flow`; obtain the enrollment token through Devin's supported login flow. These commands neither reuse a guessed token nor sign out the system account. Settings → AI Provider Accounts provides the enrollment command, refresh, selection, and removal for the selected Orca host.

Each profile belongs to the execution host. OpenCode's SQLite credentials and Devin's credential TOML stay in private Orca user-data directories. Enrollment isolates XDG data/config/cache/state, copies only authenticated credentials, and then deletes the temporary directory. OpenCode capture rejects databases containing conversations and includes SQLite WAL contents. RPC summaries contain labels, IDs, and integration names, never tokens or credential paths. Only the authenticated local runtime socket can import a credential directory; paired clients cannot ask the host to read arbitrary paths.

Selection affects newly launched explicit OpenCode/Devin commands and agent launches. It redirects XDG data and state; OpenCode inline-auth/database overrides cannot bypass the profile. Shell wrappers restore this selection after user startup files. Existing provider configuration and environment-based integrations remain available. Running terminals retain their current profile. Stop agents before removing a profile: removal also deletes conversations created in that private profile, without changing the system login.

For SSH, enroll by running the command on a headless Orca runtime on the remote machine. The remote runtime owns its profiles and selection; a desktop client's credential paths never cross SSH. Direct SSH relay launches and Windows-hosted WSL panes do not consume the desktop host's profiles. Run a headless runtime inside that execution environment instead. Folder workspaces use the same host account store as git worktrees. Older Orca hosts reject new operations before login through capability negotiation.

Validation covers OpenCode 2.0.16 on macOS and Linux arm64, including isolated official enrollment, selected and System background-terminal credential checks, reselection, and profile deletion. Linux checks used the Node headless runtime in an Ubuntu 24.04 container. Devin 3000.10.31 saved-login recognition was checked on macOS. Fresh Devin manual-token enrollment, a physical SSH host, Linux desktop UI, Windows, and Windows-hosted WSL still require verification.
