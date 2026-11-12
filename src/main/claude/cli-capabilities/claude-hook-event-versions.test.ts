import { describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))

import { probeClaudeCliVersion } from './claude-hook-event-versions'

describe('identified Claude version output', () => {
  // Recorded macOS 2.1.310 / Windows 2.1.221 probes; historical releases' CLI source
  // registers the same suffix (1.0.23, 1.0.64, 2.0.0 and 2.1.100).

  it('does not accept marked output from a failed probe', async () => {
    vi.mocked(runProcess).mockResolvedValue({
      stdout: '2.1.310 (Claude Code)\n',
      stderr: '',
      code: 1,
      signal: null,
      timedOut: false
    })
    expect(await probeClaudeCliVersion('/bin/claude')).toBeNull()
  })
})
