import { describe, expect, it } from 'vitest'
import { recordSessionScanIssue } from './session-scan-issues'
import { formatFileTooLargeMessage } from '../../shared/editor-file-read-limit'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'

describe('recordSessionScanIssue', () => {
  // The relay's AI Vault provider reuses the editor's file reader, so its refusal
  // carries the editor's machine-readable marker. The panel renders issue.message
  // verbatim, so the marker has to be gone before it is recorded.
  it('strips the editor read-limit marker from a transcript read failure', () => {
    const issues: AiVaultScanIssue[] = []

    recordSessionScanIssue(issues, {
      agent: 'claude',
      path: '/home/u/.claude/projects/x/session.jsonl',
      message: formatFileTooLargeMessage({
        byteLength: 13_002_342,
        limitBytes: 10 * 1024 * 1024,
        scope: 'ssh'
      })
    })

    expect(issues[0]!.message).toBe(
      'File too large: 12.4 MB exceeds the 10.0 MB read limit for files on this SSH host.'
    )
  })

  it('strips the bare protocol marker a host with nothing to report emits', () => {
    const issues: AiVaultScanIssue[] = []

    recordSessionScanIssue(issues, {
      agent: 'codex',
      path: '/home/u/.codex/sessions/a.jsonl',
      message: formatFileTooLargeMessage({})
    })

    expect(issues[0]!.message).toBe('File too large: over the read limit.')
  })

  it('leaves an unrelated failure untouched', () => {
    const issues: AiVaultScanIssue[] = []

    recordSessionScanIssue(issues, {
      agent: 'codex',
      path: '/home/u/.codex/sessions/a.jsonl',
      message: 'EACCES: permission denied, open [/home/u/.codex]'
    })

    expect(issues[0]!.message).toBe('EACCES: permission denied, open [/home/u/.codex]')
  })
})
