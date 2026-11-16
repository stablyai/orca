// Every feature the eval covers: the rows of the parity matrix plus the accounts, team,
// Stripe and safety flows. `peer` is what the peer shipped (from the matrix), `owner` is the
// workstream that lands it, `better` is where Orca is designed to beat the peer (verified by the check).
export type Feature = {
  id: string
  section: string
  feature: string
  peer: string
  owner: string
  priority: 'P0' | 'P1' | 'P2' | 'ops'
  better?: string
}

const S = {
  acct: '0. Accounts, team and billing',
  sub: '1. Substrate, size and limits',
  env: '2. Environment builds',
  sec: '3. Secrets, env and agent auth',
  life: '4. Lifecycle: sleep, wake, cap, health',
  acc: '5. Access: terminals, SSH, files, ports, preview',
  mp: '6. Team / multiplayer',
  api: '7. Programmability: API, MCP, CLI, routines',
  cli: '8. Clients',
  ops: '9. Safety, cost and operations'
}

export const SECTIONS = Object.values(S)

export const CATALOG: Feature[] = [
  // 0. Accounts, team, billing
  { id: 'acct.signin', section: S.acct, feature: 'Sign in (dev-signed Orca token) reaches control plane and billing', peer: 'Account sign-in', owner: 'core', priority: 'P0' },
  { id: 'acct.isolation', section: S.acct, feature: 'Another account cannot see or act on my sandboxes', peer: 'n/a (not documented)', owner: 'core', priority: 'P0' },
  { id: 'team.create', section: S.acct, feature: 'Create a team (org) and become its owner', peer: 'Teams plan, invite-only then self-serve', owner: 'team-billing-ux', priority: 'P0' },
  { id: 'team.invite', section: S.acct, feature: 'Invite a member; seats follow membership', peer: 'Teams $60/user/mo', owner: 'team-billing-ux', priority: 'P0' },
  { id: 'billing.checkout', section: S.acct, feature: 'Stripe TEST Checkout with 4242 card activates Team plan', peer: 'Stripe billing portal, monthly only', owner: 'team-billing-ux', priority: 'P0', better: 'Annual plan option, in-app plans page' },
  { id: 'billing.checkout-3ds', section: S.acct, feature: 'Checkout with a 3DS-required test card (challenge completed)', peer: 'not documented', owner: 'team-billing-ux', priority: 'P0' },
  { id: 'billing.seat-proration', section: S.acct, feature: 'Adding a seat prorates immediately; removing credits next invoice', peer: 'not documented', owner: 'team-billing-ux', priority: 'P0' },
  { id: 'billing.overage', section: S.acct, feature: 'Overage opt-in at $0.75/h with a monthly spend cap that blocks starts', peer: 'No metering ("no extra charge today")', owner: 'team-billing-ux', priority: 'P0', better: 'Metered from day one with a hard cap' },
  { id: 'billing.dunning', section: S.acct, feature: 'Payment failure -> grace -> suspend -> pay -> resume (test clocks)', peer: 'not documented', owner: 'team-billing-ux', priority: 'P0' },
  { id: 'billing.entitlement-gate', section: S.acct, feature: 'Account without a plan is refused a sandbox (fail closed)', peer: 'Pro/org required', owner: 'core', priority: 'P0' },
  // The peer's local core workflow (added after the independent audit; the cloud matrix left it out)
  { id: 'local.core-workflow', section: S.acct, feature: 'Local core workflow: create a local worktree, run an agent, see the diff, commit (desktop)', peer: 'Core local app (free)', owner: 'eval (m4air desktop run)', priority: 'P0' },
  { id: 'local.run-actions', section: S.acct, feature: 'Run actions: orca.yaml scripts.run on the Run button, "Run: <name>" terminal, trust prompt once, Stop (Ctrl+C → Stopped), Restart, ⌥⌘↩, autoRunAfterSetup only after a successful setup', peer: '0.70 multiple run scripts, ⌘R, auto-run after setup', owner: 'gap-run-actions', priority: 'P0' },
  { id: 'run.ports', section: S.acct, feature: 'Per-workspace port block: ORCA_PORT / ORCA_PORT_COUNT=10 / CONDUCTOR_PORT, distinct per workspace, stable across restarts; Vite via Run listens on $ORCA_PORT locally and in cloud (auto-forward)', peer: 'CONDUCTOR_PORT 10-port block', owner: 'gap-run-actions', priority: 'P0' },
  { id: 'run.nonconcurrent', section: S.acct, feature: 'runMode nonconcurrent stops the same action in another workspace first', peer: 'run_mode', owner: 'gap-run-actions', priority: 'P1' },
  { id: 'run.cloud-resume', section: S.life, feature: 'A running action comes back after wake and after rollover in a cloud workspace', peer: 'Restart run scripts after wake (manual)', owner: 'gap-run-actions', priority: 'P0', better: 'Comes back by itself' },
  { id: 'run.conductor-import', section: S.acct, feature: 'Conductor importer keeps run / run_mode / auto_run_after_setup (settings.toml, settings.local.toml, conductor.json)', peer: 'n/a (migration)', owner: 'gap-run-actions', priority: 'P0' },
  { id: 'life.read-asleep', section: S.life, feature: 'Chats, PR comments and check logs readable while asleep from any device (no wake)', peer: '0.80/0.85, server-held', owner: 'gap-read-asleep', priority: 'P0' },
  { id: 'life.read-asleep-access', section: S.life, feature: 'Read-while-asleep access control: removed member loses access at once (keys deleted), private workspace is owner-only', peer: 'Org access to server-held chats', owner: 'gap-read-asleep', priority: 'P0', better: 'End-to-end encrypted; server holds only ciphertext' },
  { id: 'life.read-asleep-phone', section: S.life, feature: 'Phone shows "Latest from this workspace" for a sleeping workspace without waking it', peer: 'iOS app reads server-held chats', owner: 'gap-read-asleep', priority: 'P1' },
  { id: 'local.checkpoints', section: S.acct, feature: 'Per-turn code checkpoints: revert restores files and chat together', peer: '0.19 (Claude), 0.44 (Codex) checkpoints', owner: 'gap-checkpoints', priority: 'P0' },
  { id: 'cloud.checkpoints', section: S.life, feature: 'Per-turn checkpoints in a cloud workspace: Rewind restores files and chat on a real VM, after sleep/wake, rollover and an orcad restart (live/checkpoints-vm.ts, no model spend)', peer: '0.19 (Claude), 0.44 (Codex) checkpoints in cloud', owner: 'checkpoints-vm', priority: 'P0' },
  // 1. Substrate
  { id: 'sub.create', section: S.sub, feature: 'Hosted microVM per workspace, one call / one click', peer: '0.78 GA', owner: 'core', priority: 'P0' },
  { id: 'sub.size', section: S.sub, feature: 'Machine size: Standard 8 vCPU / 16 GB (peer parity)', peer: 'Fixed 8 vCPU / 16 GB', owner: 'core', priority: 'P0' },
  { id: 'sub.disk', section: S.sub, feature: 'Disk >= 32 GB and low-disk alert', peer: '64 GB (0.82), low-disk alerts', owner: 'env-builds', priority: 'P1' },
  { id: 'sub.tools', section: S.sub, feature: 'Preinstalled tools (node, git, gh, rg, jq, python3, orca CLI, Claude, Codex)', peer: 'AL2023, Node 24, git, gh, jq, rg, LFS, tmux, Vim, Chrome', owner: 'core', priority: 'P0' },
  { id: 'sub.region', section: S.sub, feature: 'Region iad1', peer: 'us-east-1 only', owner: 'core', priority: 'P0' },
  { id: 'sub.github-clone', section: S.sub, feature: 'Private GitHub repo cloned at create via the Orca GitHub App', peer: 'GitHub App, GitHub only', owner: 'core', priority: 'P0', better: 'Token never written to the VM disk (egress injection)' },
  // 2. Env builds
  { id: 'env.build', section: S.env, feature: 'Org environment build (repos, env, install script) with logs', peer: '0.78 Cloud Computer, build logs', owner: 'env-builds', priority: 'P0' },
  { id: 'env.versions', section: S.env, feature: 'Versioned builds, history, activate older build (rollback)', peer: '0.78 history + rollback', owner: 'env-builds', priority: 'P1' },
  { id: 'env.pinned', section: S.env, feature: 'Existing workspaces keep their build after a rebuild', peer: 'Yes', owner: 'env-builds', priority: 'P0' },
  { id: 'env.from-build', section: S.env, feature: 'Create a cloud workspace from a build (warm repo snapshot)', peer: 'Yes', owner: 'env-builds', priority: 'P0', better: 'Warm per-repo snapshot' },
  { id: 'env.setup-script', section: S.env, feature: 'Per-repo setup script runs inside the VM on each new workspace', peer: 'Cloud repo setup scripts', owner: 'env-builds', priority: 'P0' },
  // 3. Secrets & agents
  { id: 'sec.org-secret', section: S.sec, feature: 'Org secret: write-only (hidden after save), injected into the VM env', peer: '0.78/0.80, values hidden, plain env in VM', owner: 'agents-secrets', priority: 'P0', better: 'Envelope encrypted; optional egress placeholder swap' },
  { id: 'sec.precedence', section: S.sec, feature: 'Personal beats org for env; org beats personal for agent keys', peer: 'Same precedence', owner: 'agents-secrets', priority: 'P0' },
  { id: 'sec.no-rebuild', section: S.sec, feature: 'Changed secret picked up on next session (no rebuild)', peer: '0.80/0.83', owner: 'agents-secrets', priority: 'P0' },
  { id: 'sec.reserved', section: S.sec, feature: 'Reserved names refused (PATH, GH_TOKEN, ORCA_*, CLAUDE_CODE_OAUTH_TOKEN)', peer: 'Reserved names', owner: 'core', priority: 'P0' },
  { id: 'sec.git-push', section: S.sec, feature: 'Real git push from the VM with an injected GitHub App token', peer: 'GitHub App', owner: 'core', priority: 'P0', better: 'No token on disk; attacker-shaped requests 403' },
  { id: 'sec.egress-deny', section: S.sec, feature: 'Egress fails closed: unlisted hosts do not resolve; foreign tokens refused', peer: 'not documented', owner: 'core', priority: 'P0', better: 'Default-deny egress' },
  { id: 'agent.real-task', section: S.sec, feature: 'Real agent task in the VM (Claude Code / Codex via AI Gateway key)', peer: 'Claude Code, Codex, Cursor with API key or subscription', owner: 'agents-secrets', priority: 'P0' },
  { id: 'agent.signin', section: S.sec, feature: 'Agent sign-in on the VM persists across sleep/rollover', peer: 'Per-org agent connections', owner: 'agents-secrets', priority: 'P0' },
  { id: 'image.agents', section: S.sec, feature: 'Agent CLIs in the image: Claude Code, Codex, Cursor, OpenCode, Gemini, Copilot', peer: 'Claude Code, Codex, Cursor (+ OpenCode)', owner: 'gap-agents', priority: 'P0' },
  { id: 'agent.keys-swap', section: S.sec, feature: 'Gemini/Cursor keys via egress swap (placeholder on VM, real key only at the provider); keys never on the VM', peer: 'Keys as plain env in the VM', owner: 'gap-agents', priority: 'P0', better: 'Agent keys never on the VM; foreign keys and paths refused' },
  { id: 'agent.more-agents', section: S.sec, feature: 'OpenCode and Copilot (BYOK) finish a real task and commit in a cloud workspace', peer: 'Cursor, OpenCode in cloud', owner: 'gap-agents', priority: 'P1' },
  // 4. Lifecycle
  { id: 'life.sleep-wake', section: S.life, feature: 'Sleep (stop + snapshot) and wake keep files and pairing', peer: 'Files + chats survive sleep; processes do not', owner: 'core', priority: 'P0', better: 'Same pairing; no re-pair' },
  { id: 'life.idle-sleep', section: S.life, feature: 'Auto-sleep when idle (lease lapses / idle stop)', peer: '20 min idle', owner: 'lifecycle', priority: 'P0' },
  { id: 'life.rollover', section: S.life, feature: '24h cap rollover keeps files, pairing and host key', peer: 'Hard stop at 23h50m, manual recovery', owner: 'core', priority: 'P0', better: 'Automatic rollover, no user action' },
  { id: 'life.auto-resume', section: S.life, feature: 'Agents auto-resume after rollover (durable offers)', peer: 'User must resend interrupted turn', owner: 'lifecycle', priority: 'P0', better: 'Agent continues by itself' },
  { id: 'life.lease', section: S.life, feature: 'Orca-owned lease renewal, clamped to the session deadline', peer: 'n/a', owner: 'core', priority: 'P0' },
  { id: 'life.wake-on-message', section: S.life, feature: 'Wake on message and deliver it', peer: '0.81/0.83', owner: 'lifecycle', priority: 'P0' },
  { id: 'life.status', section: S.life, feature: 'Status panel: provisioning/sleeping/waking/ready/unresponsive + Restart', peer: 'CPU, memory, Restart, Unresponsive', owner: 'lifecycle', priority: 'P0' },
  { id: 'life.archive', section: S.life, feature: 'Archive (stopped, snapshot kept with TTL) and unarchive', peer: 'API 0.79, docs', owner: 'lifecycle', priority: 'P0' },
  { id: 'life.transfer-local', section: S.life, feature: 'Transfer a cloud workspace to local', peer: '0.93', owner: 'lifecycle', priority: 'P1' },
  { id: 'life.oom', section: S.life, feature: 'OOM explanation and restart offer', peer: 'Changelog', owner: 'lifecycle', priority: 'P1' },
  // 5. Access
  { id: 'acc.terminal', section: S.acc, feature: 'Cloud terminal: open PTY, type, read echo (orca CLI over pairing)', peer: 'Cloud terminal', owner: 'core', priority: 'P0' },
  { id: 'acc.ports', section: S.acc, feature: 'Listening-port detection with process name', peer: '0.81/0.89', owner: 'networking', priority: 'P0' },
  { id: 'acc.port-forward', section: S.acc, feature: 'Forward a VM port to localhost (same port number)', peer: '0.80/0.82/0.83 auto-forward', owner: 'networking', priority: 'P0' },
  { id: 'acc.share-link', section: S.acc, feature: 'Share link to a cloud app (public preview URL)', peer: '0.84.1', owner: 'networking', priority: 'P1' },
  { id: 'acc.ssh', section: S.acc, feature: 'SSH / open in VS Code or Cursor', peer: '0.83/0.89', owner: 'networking', priority: 'P1' },
  { id: 'acc.download', section: S.acc, feature: 'Download a file from the VM', peer: '0.82', owner: 'networking', priority: 'P1' },
  { id: 'acc.remote-desktop', section: S.acc, feature: 'Remote desktop (full GUI tab) streamed from the VM', peer: '0.84 experimental; desktop tabs 0.89', owner: 'networking', priority: 'P2', better: 'Reached only through the E2EE pairing (no public route), single-use tickets' },
  { id: 'acc.search', section: S.acc, feature: 'File-content search over the runtime', peer: '0.85/0.87', owner: 'core', priority: 'P0' },
  // 6. Multiplayer
  { id: 'mp.registry', section: S.mp, feature: 'Org workspaces visible to the team', peer: '0.77 alpha, 0.78 GA', owner: 'multiplayer', priority: 'P1' },
  { id: 'mp.teammate-open', section: S.mp, feature: "Team member opens a teammate's workspace", peer: 'Yes', owner: 'multiplayer', priority: 'P1' },
  { id: 'mp.private', section: S.mp, feature: 'Private workspaces hidden from the team', peer: '0.85', owner: 'multiplayer', priority: 'P1' },
  { id: 'mp.links', section: S.mp, feature: 'Workspace links resolve through the registry', peer: '0.71/0.78', owner: 'multiplayer', priority: 'P1' },
  { id: 'mp.cost', section: S.mp, feature: 'Cost per workspace in the list', peer: '0.92', owner: 'multiplayer', priority: 'P1' },
  // 7. Programmability
  { id: 'api.rest', section: S.api, feature: 'REST API: create/status/sleep/archive workspaces with an API key', peer: 'API v0 (beta)', owner: 'api-routines', priority: 'P1' },
  { id: 'api.mcp', section: S.api, feature: 'Hosted MCP server', peer: '0.82 (beta)', owner: 'api-routines', priority: 'P1' },
  { id: 'api.cli', section: S.api, feature: 'Create a cloud workspace from the CLI', peer: 'API create_session', owner: 'api-routines', priority: 'P1' },
  { id: 'api.routine-cron', section: S.api, feature: 'Routine on a schedule runs on a fresh VM, then destroys it', peer: '0.85/0.87', owner: 'api-routines', priority: 'P1' },
  { id: 'api.routine-webhook', section: S.api, feature: 'Webhook / GitHub-triggered routine', peer: '0.85/0.87, API webhook', owner: 'api-routines', priority: 'P1' },
  // 8. Clients
  { id: 'cli.mobile', section: S.cli, feature: 'Mobile reaches a cloud workspace (stable endpoint, wake from phone)', peer: 'iOS app 0.90', owner: 'mobile', priority: 'P0', better: 'iOS + Android, E2EE' },
  { id: 'cli.web', section: S.cli, feature: 'Web client reaches a cloud workspace', peer: 'Mac only', owner: 'mobile', priority: 'P1', better: 'Web, Windows, Linux too' },
  { id: 'cli.desktop', section: S.cli, feature: 'Desktop app: pick Orca Cloud, create, shell, sleep/wake (Playwright/Electron)', peer: 'Mac desktop', owner: 'core', priority: 'P0' },
  // Desktop-only checks (desktop/run-desktop.mjs, folded in by import-desktop.ts); D-n are the #127 fixes.
  { id: 'cli.desktop-signin', section: S.cli, feature: 'Desktop: signed-out Orca Cloud create shows the sign-in card and creates nothing; signing in from the card carries the create through as that user', peer: 'Sign-in required', owner: 'core-desktop-fixes', priority: 'P0' },
  { id: 'cli.desktop-project-name', section: S.cli, feature: 'Desktop: a cloud create files the workspace under the real project, never a new "project" project', peer: 'n/a', owner: 'core-desktop-fixes', priority: 'P1' },
  { id: 'cli.desktop-delete', section: S.cli, feature: 'Desktop: Delete on a cloud workspace removes the row and the sandbox reaches destroyed', peer: 'Delete workspace', owner: 'core', priority: 'P0' },
  { id: 'cli.desktop-delete-unconfirmed', section: S.cli, feature: 'Desktop: Delete after switching team away from the sandbox’s creator destroys it; if Orca Cloud can’t confirm, the row stays with “couldn’t confirm”', peer: 'not documented', owner: 'core-desktop-fixes', priority: 'P0', better: 'Never reports a possibly-running sandbox as deleted' },
  { id: 'cli.desktop-delete-gone', section: S.cli, feature: 'Desktop: deleting a workspace whose sandbox was already destroyed elsewhere removes the row', peer: 'not documented', owner: 'core', priority: 'P1' },
  { id: 'cli.desktop-picker-signin', section: S.cli, feature: 'Desktop: signing in from the Run-on picker’s Orca Cloud row leaves Orca Cloud selected (#149)', peer: 'n/a', owner: 'core-desktop-fixes', priority: 'P1' },
  { id: 'cli.desktop-delete-asleep', section: S.cli, feature: 'Desktop: Delete on an asleep cloud workspace never wakes it and destroys the VM (the dialog Delete is the confirmed force; no separate Force delete offer) (#149)', peer: 'not documented', owner: 'core-desktop-fixes', priority: 'P0' },
  { id: 'cli.desktop-delete-asleep-moved', section: S.cli, feature: 'Desktop: the same asleep Delete right after Move to this computer (#149)', peer: 'not documented', owner: 'core-desktop-fixes', priority: 'P1' },
  { id: 'cli.desktop-move-then-delete', section: S.cli, feature: 'Desktop: Move to this computer with Archive afterwards, then Delete within seconds: destroyed, no suspend/archive error toasts (#157)', peer: 'not documented', owner: 'core-desktop-fixes', priority: 'P1' },
  // 9. Ops
  { id: 'ops.kill-switch', section: S.ops, feature: 'Operator kill switch refuses creates/resumes', peer: 'n/a', owner: 'core', priority: 'ops' },
  { id: 'ops.caps', section: S.ops, feature: 'Per-account concurrency cap and create rate limit', peer: 'n/a', owner: 'core', priority: 'ops' },
  { id: 'ops.orphan-sweep', section: S.ops, feature: 'Orphan sweep / housekeeping runs and leaves no strays', peer: 'n/a', owner: 'core', priority: 'ops' },
  { id: 'ops.cleanup', section: S.ops, feature: 'Destroy removes the sandbox and every snapshot (zero left after the run)', peer: 'n/a', owner: 'core', priority: 'ops' },
  { id: 'ops.usage', section: S.ops, feature: 'Usage metered per session segment (billing ledger)', peer: 'No metering', owner: 'core', priority: 'ops' }
]

export const featureById = new Map(CATALOG.map((f) => [f.id, f]))
