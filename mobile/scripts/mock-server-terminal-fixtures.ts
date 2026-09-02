export const FAKE_SCROLLBACK = [
  '$ claude "refactor the auth module to use JWT tokens"',
  '',
  '⏳ Working on it...',
  '',
  "I'll refactor the auth module. Here's my plan:",
  '1. Replace session-based auth with JWT',
  '2. Add token refresh endpoint',
  '3. Update middleware',
  '',
  'Let me start by reading the current auth module...',
  ''
].join('\n')

export const STREAMING_CHUNKS = [
  'Reading src/auth/middleware.ts...\n',
  'Reading src/auth/session.ts...\n',
  '\nI see the current implementation uses express-session.\n',
  "I'll replace it with jsonwebtoken.\n",
  '\nUpdating src/auth/middleware.ts...\n'
]

export function createMockTerminals(worktreeId?: string) {
  const resolvedWorktreeId = worktreeId ?? 'repo-1::/tmp/orca-mobile-repro/orca'
  return [
    {
      handle: 'term-1',
      worktreeId: resolvedWorktreeId,
      title: 'Claude — auth refactor',
      isActive: true,
      hasRunningProcess: true
    },
    {
      handle: 'term-2',
      worktreeId: resolvedWorktreeId,
      title: 'zsh',
      isActive: false,
      hasRunningProcess: false
    }
  ]
}
