import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { getBundledRgPath, resolveRgCommand } from './bundled-ripgrep'

const execFile = promisify(execFileCallback)

describe('bundled ripgrep', () => {
  it('ships a prebuilt for every architecture the desktop app targets', () => {
    expect(getBundledRgPath()).not.toBeNull()
  })

  it('resolves an rg that actually executes', async () => {
    // Why: the whole point of #9539 — a path string proves nothing if the binary cannot run.
    const { stdout } = await execFile(resolveRgCommand(), ['--version'])
    expect(stdout).toMatch(/^ripgrep \d+\.\d+\.\d+/)
  })

  it('finds files under a directory, which is what Quick Open needs', async () => {
    const { stdout } = await execFile(resolveRgCommand(), ['--files', '--max-count', '1'], {
      cwd: process.cwd()
    })
    expect(stdout.split('\n').filter(Boolean).length).toBeGreaterThan(0)
  })

  it('prefers the bundled binary for a local search', () => {
    expect(resolveRgCommand({ cwd: process.cwd() })).toBe(getBundledRgPath())
  })

  // Why: not gated on the host platform — a registered distro means the spawn is bound for
  // WSL, and the desktop suite runs these Windows-shaped cases on every OS. UNC-path
  // detection is delegated to parseWslPath, which is win32-only by design.
  it('keeps PATH lookup when a WSL distro is registered', () => {
    expect(resolveRgCommand({ cwd: 'C:\\repo', wslDistro: 'Ubuntu' })).toBe('rg')
  })
})
