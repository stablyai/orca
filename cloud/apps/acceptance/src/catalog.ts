// Every feature the eval covers: the rows of conductor-parity-matrix.html plus the accounts, team,
// Stripe and safety flows. `conductor` is what Conductor shipped (from the matrix), `owner` is the
// workstream that lands it, `better` is where Orca is designed to beat Conductor (verified by the check).
export type Feature = {
  id: string
  section: string
  feature: string
  conductor: string
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
  { id: 'acct.signin', section: S.acct, feature: 'Sign in (dev-signed Orca token) reaches control plane and billing', conductor: 'Conductor account sign-in', owner: 'core', priority: 'P0' },
  { id: 'acct.isolation', section: S.acct, feature: 'Another account cannot see or act on my sandboxes', conductor: 'n/a (not documented)', owner: 'core', priority: 'P0' },
  { id: 'team.create', section: S.acct, feature: 'Create a team (org) and become its owner', conductor: 'Teams plan, invite-only then self-serve', owner: 'team-billing-ux', priority: 'P0' },
  { id: 'team.invite', section: S.acct, feature: 'Invite a member; seats follow membership', conductor: 'Teams $60/user/mo', owner: 'team-billing-ux', priority: 'P0' },
  { id: 'billing.checkout', section: S.acct, feature: 'Stripe TEST Checkout with 4242 card activates Team plan', conductor: 'Stripe billing portal, monthly only', owner: 'team-billing-ux', priority: 'P0', better: 'Annual plan option, in-app plans page' },
  { id: 'billing.checkout-3ds', section: S.acct, feature: 'Checkout with a 3DS-required test card (challenge completed)', conductor: 'not documented', owner: 'team-billing-ux', priority: 'P0' },
  { id: 'billing.seat-proration', section: S.acct, feature: 'Adding a seat prorates immediately; removing credits next invoice', conductor: 'not documented', owner: 'team-billing-ux', priority: 'P0' },
  { id: 'billing.overage', section: S.acct, feature: 'Overage opt-in at $0.75/h with a monthly spend cap that blocks starts', conductor: 'No metering ("no extra charge today")', owner: 'team-billing-ux', priority: 'P0', better: 'Metered from day one with a hard cap' },
  { id: 'billing.dunning', section: S.acct, feature: 'Payment failure -> grace -> suspend -> pay -> resume (test clocks)', conductor: 'not documented', owner: 'team-billing-ux', priority: 'P0' },
  { id: 'billing.entitlement-gate', section: S.acct, feature: 'Account without a plan is refused a sandbox (fail closed)', conductor: 'Pro/org required', owner: 'core', priority: 'P0' },
  // 1. Substrate
  { id: 'sub.create', section: S.sub, feature: 'Hosted microVM per workspace, one call / one click', conductor: '0.78 GA', owner: 'core', priority: 'P0' },
  { id: 'sub.size', section: S.sub, feature: 'Machine sizes (standard 4 vCPU, large 8 vCPU)', conductor: 'Fixed 8 vCPU / 16 GB', owner: 'core', priority: 'P0', better: 'Choice of size' },
  { id: 'sub.disk', section: S.sub, feature: 'Disk >= 32 GB and low-disk alert', conductor: '64 GB (0.82), low-disk alerts', owner: 'w1-env-builds', priority: 'P1' },
  { id: 'sub.tools', section: S.sub, feature: 'Preinstalled tools (node, git, gh, rg, jq, python3, orca CLI, Claude, Codex)', conductor: 'AL2023, Node 24, git, gh, jq, rg, LFS, tmux, Vim, Chrome', owner: 'core', priority: 'P0' },
  { id: 'sub.region', section: S.sub, feature: 'Region iad1', conductor: 'us-east-1 only', owner: 'core', priority: 'P0' },
  { id: 'sub.github-clone', section: S.sub, feature: 'Private GitHub repo cloned at create via the Orca GitHub App', conductor: 'GitHub App, GitHub only', owner: 'core', priority: 'P0', better: 'Token never written to the VM disk (egress injection)' },
  // 2. Env builds
  { id: 'env.build', section: S.env, feature: 'Org environment build (repos, env, install script) with logs', conductor: '0.78 Cloud Computer, build logs', owner: 'w1-env-builds', priority: 'P0' },
  { id: 'env.versions', section: S.env, feature: 'Versioned builds, history, activate older build (rollback)', conductor: '0.78 history + rollback', owner: 'w1-env-builds', priority: 'P1' },
  { id: 'env.pinned', section: S.env, feature: 'Existing workspaces keep their build after a rebuild', conductor: 'Yes', owner: 'w1-env-builds', priority: 'P0' },
  { id: 'env.from-build', section: S.env, feature: 'Create a cloud workspace from a build (warm repo snapshot)', conductor: 'Yes', owner: 'w1-env-builds', priority: 'P0', better: 'Warm per-repo snapshot' },
  { id: 'env.setup-script', section: S.env, feature: 'Per-repo setup script runs inside the VM on each new workspace', conductor: 'Cloud repo setup scripts', owner: 'w1-env-builds', priority: 'P0' },
  // 3. Secrets & agents
  { id: 'sec.org-secret', section: S.sec, feature: 'Org secret: write-only (hidden after save), injected into the VM env', conductor: '0.78/0.80, values hidden, plain env in VM', owner: 'w6-agents-secrets', priority: 'P0', better: 'Envelope encrypted; optional egress placeholder swap' },
  { id: 'sec.precedence', section: S.sec, feature: 'Personal beats org for env; org beats personal for agent keys', conductor: 'Same precedence', owner: 'w6-agents-secrets', priority: 'P0' },
  { id: 'sec.no-rebuild', section: S.sec, feature: 'Changed secret picked up on next session (no rebuild)', conductor: '0.80/0.83', owner: 'w6-agents-secrets', priority: 'P0' },
  { id: 'sec.reserved', section: S.sec, feature: 'Reserved names refused (PATH, GH_TOKEN, ORCA_*, CLAUDE_CODE_OAUTH_TOKEN)', conductor: 'Reserved names', owner: 'core', priority: 'P0' },
  { id: 'sec.git-push', section: S.sec, feature: 'Real git push from the VM with an injected GitHub App token', conductor: 'GitHub App', owner: 'core', priority: 'P0', better: 'No token on disk; attacker-shaped requests 403' },
  { id: 'sec.egress-deny', section: S.sec, feature: 'Egress fails closed: unlisted hosts do not resolve; foreign tokens refused', conductor: 'not documented', owner: 'core', priority: 'P0', better: 'Default-deny egress' },
  { id: 'agent.real-task', section: S.sec, feature: 'Real agent task in the VM (Claude Code / Codex via AI Gateway key)', conductor: 'Claude Code, Codex, Cursor with API key or subscription', owner: 'w6-agents-secrets', priority: 'P0' },
  { id: 'agent.signin', section: S.sec, feature: 'Agent sign-in on the VM persists across sleep/rollover', conductor: 'Per-org agent connections', owner: 'w6-agents-secrets', priority: 'P0' },
  // 4. Lifecycle
  { id: 'life.sleep-wake', section: S.life, feature: 'Sleep (stop + snapshot) and wake keep files and pairing', conductor: 'Files + chats survive sleep; processes do not', owner: 'core', priority: 'P0', better: 'Same pairing; no re-pair' },
  { id: 'life.idle-sleep', section: S.life, feature: 'Auto-sleep when idle (lease lapses / idle stop)', conductor: '20 min idle', owner: 'w2-lifecycle', priority: 'P0' },
  { id: 'life.rollover', section: S.life, feature: '24h cap rollover keeps files, pairing and host key', conductor: 'Hard stop at 23h50m, manual recovery', owner: 'core', priority: 'P0', better: 'Automatic rollover, no user action' },
  { id: 'life.auto-resume', section: S.life, feature: 'Agents auto-resume after rollover (durable offers)', conductor: 'User must resend interrupted turn', owner: 'w2-lifecycle', priority: 'P0', better: 'Agent continues by itself' },
  { id: 'life.lease', section: S.life, feature: 'Orca-owned lease renewal, clamped to the session deadline', conductor: 'n/a', owner: 'core', priority: 'P0' },
  { id: 'life.wake-on-message', section: S.life, feature: 'Wake on message and deliver it', conductor: '0.81/0.83', owner: 'w2-lifecycle', priority: 'P0' },
  { id: 'life.status', section: S.life, feature: 'Status panel: provisioning/sleeping/waking/ready/unresponsive + Restart', conductor: 'CPU, memory, Restart, Unresponsive', owner: 'w2-lifecycle', priority: 'P0' },
  { id: 'life.archive', section: S.life, feature: 'Archive (stopped, snapshot kept with TTL) and unarchive', conductor: 'API 0.79, docs', owner: 'w2-lifecycle', priority: 'P0' },
  { id: 'life.transfer-local', section: S.life, feature: 'Transfer a cloud workspace to local', conductor: '0.93', owner: 'w2-lifecycle', priority: 'P1' },
  { id: 'life.oom', section: S.life, feature: 'OOM explanation and restart offer', conductor: 'Changelog', owner: 'w2-lifecycle', priority: 'P1' },
  // 5. Access
  { id: 'acc.terminal', section: S.acc, feature: 'Cloud terminal: open PTY, type, read echo (orca CLI over pairing)', conductor: 'Cloud terminal', owner: 'core', priority: 'P0' },
  { id: 'acc.ports', section: S.acc, feature: 'Listening-port detection with process name', conductor: '0.81/0.89', owner: 'w3-networking', priority: 'P0' },
  { id: 'acc.port-forward', section: S.acc, feature: 'Forward a VM port to localhost (same port number)', conductor: '0.80/0.82/0.83 auto-forward', owner: 'w3-networking', priority: 'P0' },
  { id: 'acc.share-link', section: S.acc, feature: 'Share link to a cloud app (public preview URL)', conductor: '0.84.1', owner: 'w3-networking', priority: 'P1' },
  { id: 'acc.ssh', section: S.acc, feature: 'SSH / open in VS Code or Cursor', conductor: '0.83/0.89', owner: 'w3-networking', priority: 'P1' },
  { id: 'acc.download', section: S.acc, feature: 'Download a file from the VM', conductor: '0.82', owner: 'w3-networking', priority: 'P1' },
  { id: 'acc.remote-desktop', section: S.acc, feature: 'Remote desktop (full GUI tab) streamed from the VM', conductor: '0.84 experimental; desktop tabs 0.89', owner: 'w3-networking', priority: 'P2', better: 'Reached only through the E2EE pairing (no public route), single-use tickets' },
  { id: 'acc.search', section: S.acc, feature: 'File-content search over the runtime', conductor: '0.85/0.87', owner: 'core', priority: 'P0' },
  // 6. Multiplayer
  { id: 'mp.registry', section: S.mp, feature: 'Org workspaces visible to the team', conductor: '0.77 alpha, 0.78 GA', owner: 'w4-multiplayer', priority: 'P1' },
  { id: 'mp.teammate-open', section: S.mp, feature: "Team member opens a teammate's workspace", conductor: 'Yes', owner: 'w4-multiplayer', priority: 'P1' },
  { id: 'mp.private', section: S.mp, feature: 'Private workspaces hidden from the team', conductor: '0.85', owner: 'w4-multiplayer', priority: 'P1' },
  { id: 'mp.links', section: S.mp, feature: 'Workspace links resolve through the registry', conductor: '0.71/0.78', owner: 'w4-multiplayer', priority: 'P1' },
  { id: 'mp.cost', section: S.mp, feature: 'Cost per workspace in the list', conductor: '0.92', owner: 'w4-multiplayer', priority: 'P1' },
  // 7. Programmability
  { id: 'api.rest', section: S.api, feature: 'REST API: create/status/sleep/archive workspaces with an API key', conductor: 'API v0 (beta)', owner: 'w5-api-routines', priority: 'P1' },
  { id: 'api.mcp', section: S.api, feature: 'Hosted MCP server', conductor: '0.82 (beta)', owner: 'w5-api-routines', priority: 'P1' },
  { id: 'api.cli', section: S.api, feature: 'Create a cloud workspace from the CLI', conductor: 'API create_session', owner: 'w5-api-routines', priority: 'P1' },
  { id: 'api.routine-cron', section: S.api, feature: 'Routine on a schedule runs on a fresh VM, then destroys it', conductor: '0.85/0.87', owner: 'w5-api-routines', priority: 'P1' },
  { id: 'api.routine-webhook', section: S.api, feature: 'Webhook / GitHub-triggered routine', conductor: '0.85/0.87, API webhook', owner: 'w5-api-routines', priority: 'P1' },
  // 8. Clients
  { id: 'cli.mobile', section: S.cli, feature: 'Mobile reaches a cloud workspace (stable endpoint, wake from phone)', conductor: 'iOS app 0.90', owner: 'w8-mobile', priority: 'P0', better: 'iOS + Android, E2EE' },
  { id: 'cli.web', section: S.cli, feature: 'Web client reaches a cloud workspace', conductor: 'Mac only', owner: 'w8-mobile', priority: 'P1', better: 'Web, Windows, Linux too' },
  { id: 'cli.desktop', section: S.cli, feature: 'Desktop app: pick Orca Cloud, create, shell, sleep/wake (Playwright/Electron)', conductor: 'Mac desktop', owner: 'core', priority: 'P0' },
  // Desktop-only checks (desktop/run-desktop.mjs, folded in by import-desktop.ts); D-n are the #127 fixes.
  { id: 'cli.desktop-signin', section: S.cli, feature: 'Desktop: signed-out Orca Cloud create shows the sign-in card and creates nothing; signing in from the card carries the create through as that user (D-1, D-4)', conductor: 'Sign-in required', owner: 'core-desktop-fixes', priority: 'P0' },
  { id: 'cli.desktop-project-name', section: S.cli, feature: 'Desktop: a cloud create files the workspace under the real project, never a new "project" project (D-3)', conductor: 'n/a', owner: 'core-desktop-fixes', priority: 'P1' },
  { id: 'cli.desktop-delete', section: S.cli, feature: 'Desktop: Delete on a cloud workspace removes the row and the sandbox reaches destroyed', conductor: 'Delete workspace', owner: 'core', priority: 'P0' },
  { id: 'cli.desktop-delete-unconfirmed', section: S.cli, feature: 'Desktop: a delete the control plane answers not_found says it couldn’t confirm and keeps the row (D-2)', conductor: 'not documented', owner: 'core-desktop-fixes', priority: 'P0', better: 'Never reports a possibly-running sandbox as deleted' },
  { id: 'cli.desktop-delete-gone', section: S.cli, feature: 'Desktop: deleting a workspace whose sandbox was already destroyed elsewhere removes the row', conductor: 'not documented', owner: 'core', priority: 'P1' },
  // 9. Ops
  { id: 'ops.kill-switch', section: S.ops, feature: 'Operator kill switch refuses creates/resumes', conductor: 'n/a', owner: 'core', priority: 'ops' },
  { id: 'ops.caps', section: S.ops, feature: 'Per-account concurrency cap and create rate limit', conductor: 'n/a', owner: 'core', priority: 'ops' },
  { id: 'ops.orphan-sweep', section: S.ops, feature: 'Orphan sweep / housekeeping runs and leaves no strays', conductor: 'n/a', owner: 'core', priority: 'ops' },
  { id: 'ops.cleanup', section: S.ops, feature: 'Destroy removes the sandbox and every snapshot (zero left after the run)', conductor: 'n/a', owner: 'core', priority: 'ops' },
  { id: 'ops.usage', section: S.ops, feature: 'Usage metered per session segment (billing ledger)', conductor: 'No metering', owner: 'core', priority: 'ops' }
]

export const featureById = new Map(CATALOG.map((f) => [f.id, f]))
