import { describe, expect, it } from 'vitest'

import { resolveWorkspaceAgentSelection } from './workspace-agent-selection'

describe('workspace agent selection', () => {
  it('falls back when a user override is unavailable after detection settles', () => {
    expect(
      resolveWorkspaceAgentSelection({
        selectionActive: true,
        settings: { defaultTuiAgent: 'codex' },
        detectedAgentIds: new Set(['claude']),
        agent: 'codex',
        overridden: true
      })
    ).toEqual({ agent: 'claude', overridden: false })
  })
})
