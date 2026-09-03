export type OciWorktreeProvider = 'claude' | 'codex'

export function buildPosixOciWorktreeSessionRecordLines(provider: OciWorktreeProvider): string[] {
  return [
    'if [ -n "${ORCA_OCI_SESSION_MANIFEST:-}" ] && \\',
    '   [ -n "${ORCA_OCI_WORKTREE_PATH:-}" ] && \\',
    '   [ -n "${ORCA_OCI_REPO_ROOT:-}" ] && \\',
    '   [ -x "${ORCA_OCI_PROVIDER_EVENT_WRITER:-}" ]; then',
    '  printf \'%s\' "$payload" | "$ORCA_OCI_PROVIDER_EVENT_WRITER" record \\',
    '    --manifest "$ORCA_OCI_SESSION_MANIFEST" \\',
    `    --provider ${provider} \\`,
    '    --worktree "$ORCA_OCI_WORKTREE_PATH" \\',
    '    --repo-root "$ORCA_OCI_REPO_ROOT" \\',
    '    --payload-stdin >/dev/null 2>&1 || :',
    'fi'
  ]
}
