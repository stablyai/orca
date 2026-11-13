export function classifyCommunityPullRequest(title: string): { kind: string; area: string } {
  const text = title.toLowerCase()
  const kind = /^(fix|bug|hotfix)\b/.test(text)
    ? 'Fixes'
    : /^(feat|feature|add)\b/.test(text)
      ? 'Features'
      : 'Other changes'
  const areas: [RegExp, string][] = [
    [/automat|schedule|workflow/, 'Automations'],
    [/skill|plugin|mcp|connector/, 'Skills & plugins'],
    [/accessib|keyboard|screen reader|a11y/, 'Accessibility'],
    [/secur|auth|permission|keychain|credential/, 'Security & accounts'],
    [/perform|memory|latency|slow|optim/, 'Performance'],
    [/chat|agent|claude|codex|model/, 'Chat & agents'],
    [/worktree|workspace|project|sidebar/, 'Workspaces'],
    [/terminal|shell|pty|console/, 'Terminal'],
    [/mobile|ios|android/, 'Mobile'],
    [/github|pull request|gitlab|commit|\bgit\b/, 'Git & reviews'],
    [/browser|webview/, 'Browser'],
    [/setting|theme|appearance/, 'Settings'],
    [/build|electron|release|updat/, 'App & build']
  ]
  return { kind, area: areas.find(([pattern]) => pattern.test(text))?.[1] ?? 'Other areas' }
}
