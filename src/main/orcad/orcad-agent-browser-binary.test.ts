import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCAD_AGENT_BROWSER_DRIVER_ENV } from '../../shared/orcad-agent-browser-name'
import {
  orcadAgentBrowserNativeName,
  resolveOrcadAgentBrowserBinary
} from './orcad-agent-browser-binary'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orcad-agent-browser-'))
  roots.push(dir)
  return dir
}

function writeDriver(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, orcadAgentBrowserNativeName(platform(), arch()))
  writeFileSync(path, '')
  chmodSync(path, 0o755)
  return path
}

describe('resolving the agent-browser driver for orcad (#33846)', () => {
  it("uses the app's bundled driver when the materialized slot has none", () => {
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir())
    const appDriver = writeDriver(join(tempDir(), 'resources'))
    expect(resolveOrcadAgentBrowserBinary({})).toBeNull()
    expect(resolveOrcadAgentBrowserBinary({ [ORCAD_AGENT_BROWSER_DRIVER_ENV]: appDriver })).toBe(
      appDriver
    )
  })

  it("prefers a standalone artifact's own driver over the app's", () => {
    const slot = tempDir()
    vi.spyOn(process, 'cwd').mockReturnValue(slot)
    const slotDriver = writeDriver(join(slot, 'node_modules', 'agent-browser', 'bin'))
    const appDriver = writeDriver(join(tempDir(), 'resources'))
    expect(resolveOrcadAgentBrowserBinary({ [ORCAD_AGENT_BROWSER_DRIVER_ENV]: appDriver })).toBe(
      slotDriver
    )
  })
})
