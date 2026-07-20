import { describe, expect, it } from 'vitest'
import { getAgentBrowserBinaryName } from './agent-browser-binary-name'

describe('getAgentBrowserBinaryName', () => {
  it('uses the upstream x64 fallback on Windows ARM64', () => {
    expect(getAgentBrowserBinaryName('win32', 'arm64')).toBe('agent-browser-win32-x64.exe')
  })

  it('keeps native architecture names on supported platforms', () => {
    expect(getAgentBrowserBinaryName('win32', 'x64')).toBe('agent-browser-win32-x64.exe')
    expect(getAgentBrowserBinaryName('darwin', 'arm64')).toBe('agent-browser-darwin-arm64')
    expect(getAgentBrowserBinaryName('linux', 'arm64')).toBe('agent-browser-linux-arm64')
  })
})
