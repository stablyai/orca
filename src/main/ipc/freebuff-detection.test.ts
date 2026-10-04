import { describe, expect, it } from 'vitest'
import {
  getTuiAgentDetectionProbeCommands,
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  resolveDetectedTuiAgentIds
} from './tui-agent-detection-commands'

describe('Freebuff detection', () => {
  it.each(['darwin', 'linux', 'win32', 'wsl'] as const)(
    'detects Freebuff independently of Codebuff on %s',
    (runtime) => {
      expect(
        getTuiAgentDetectionProbeCommands(KNOWN_TUI_AGENT_DETECTION_COMMANDS, runtime)
      ).toContain('freebuff')
      expect(
        resolveDetectedTuiAgentIds(
          KNOWN_TUI_AGENT_DETECTION_COMMANDS,
          new Set(['freebuff']),
          runtime
        )
      ).toEqual(['freebuff'])
      expect(
        resolveDetectedTuiAgentIds(
          KNOWN_TUI_AGENT_DETECTION_COMMANDS,
          new Set(['codebuff']),
          runtime
        )
      ).toEqual(['codebuff'])
      expect(
        resolveDetectedTuiAgentIds(
          KNOWN_TUI_AGENT_DETECTION_COMMANDS,
          new Set(['freebuff', 'codebuff']),
          runtime
        )
      ).toEqual(expect.arrayContaining(['freebuff', 'codebuff']))
    }
  )
})
