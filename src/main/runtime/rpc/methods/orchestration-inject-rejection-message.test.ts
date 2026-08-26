import { describe, expect, it } from 'vitest'
import { buildInjectRejectionMessage } from './orchestration-inject-rejection-message'
import { TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import { recognizeAgentProcess } from '../../../../shared/agent-process-recognition'

describe('buildInjectRejectionMessage', () => {
  const message = buildInjectRejectionMessage('term_a')

  it('keeps the substring callers and scripts match on', () => {
    expect(message).toContain('Cannot dispatch --inject to terminal term_a')
    expect(message).toContain('no recognized agent detected')
  })

  it('names every agent Orca recognizes, including agy', () => {
    expect(message).toMatch(/\bagy\b/)
    for (const config of Object.values(TUI_AGENT_CONFIG)) {
      expect(message).toContain(config.expectedProcess)
    }
  })

  it('lists only names detection actually resolves, deduped and sorted', () => {
    const listed = (/\(([^)]+)\)/.exec(message)?.[1] ?? '').split(', ')

    expect(listed.length).toBeGreaterThan(0)
    expect(new Set(listed).size).toBe(listed.length)
    expect([...listed].sort()).toEqual(listed)
    for (const name of listed) {
      expect(recognizeAgentProcess(name)).not.toBeNull()
    }
  })
})
