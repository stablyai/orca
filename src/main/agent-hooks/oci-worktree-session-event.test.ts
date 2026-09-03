import { describe, expect, it } from 'vitest'
import { buildPosixOciWorktreeSessionRecordLines } from './oci-worktree-session-event'

const expectedLines = (provider: 'claude' | 'codex'): string[] => [
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

describe('buildPosixOciWorktreeSessionRecordLines', () => {
  it('emits the guarded Claude recorder contract', () => {
    const lines = buildPosixOciWorktreeSessionRecordLines('claude')
    const output = lines.join('\n')

    expect(lines).toEqual(expectedLines('claude'))
    expect(output).toContain('--provider claude')
    expect(output).toContain('ORCA_OCI_SESSION_MANIFEST')
    expect(output).not.toContain('ORCA_AGENT_HOOK_ENDPOINT')
    expect(output).not.toContain('ORCA_PANE_KEY')
  })

  it('bakes the Codex provider into the recorder contract', () => {
    const lines = buildPosixOciWorktreeSessionRecordLines('codex')
    const output = lines.join('\n')

    expect(lines).toEqual(expectedLines('codex'))
    expect(output).toContain('--provider codex')
    expect(output).toContain('ORCA_OCI_SESSION_MANIFEST')
    expect(output).not.toContain('ORCA_AGENT_HOOK_ENDPOINT')
    expect(output).not.toContain('ORCA_PANE_KEY')
  })
})
