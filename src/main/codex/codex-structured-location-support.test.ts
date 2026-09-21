import { describe, expect, it } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { supportsCodexStructuredLocation } from './codex-structured-location-support'

const LOCAL_WINDOWS_LOCATION: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'folder'
}

const WSL_WINDOWS_LOCATION: AgentSessionExecutionLocation = {
  ...LOCAL_WINDOWS_LOCATION,
  wslDistro: 'Ubuntu'
}

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return run()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('Codex structured location support', () => {
  it('uses the injected Windows identity capability for location admission', () => {
    let proofAvailable = false
    withPlatform('win32', () => {
      expect(supportsCodexStructuredLocation(LOCAL_WINDOWS_LOCATION, () => proofAvailable)).toBe(
        false
      )
      proofAvailable = true
      expect(supportsCodexStructuredLocation(LOCAL_WINDOWS_LOCATION, () => proofAvailable)).toBe(
        true
      )
    })
  })

  it('rejects WSL locations while retaining native folder support on Windows', () => {
    withPlatform('win32', () => {
      expect(supportsCodexStructuredLocation(WSL_WINDOWS_LOCATION, () => true)).toBe(false)
      expect(supportsCodexStructuredLocation(LOCAL_WINDOWS_LOCATION, () => true)).toBe(true)
    })
  })
})
