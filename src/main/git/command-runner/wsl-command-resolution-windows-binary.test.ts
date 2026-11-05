import { afterEach, describe, expect, it } from 'vitest'
import { resolveCommand } from './wsl-command-resolution'

const originalPlatform = process.platform
const UNC_REPO = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'

describe('resolveCommand wslShellCommand', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  it('uses the pre-quoted shell expression in place of the command inside WSL', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    const resolved = resolveCommand('rg', ['--files'], UNC_REPO, undefined, {
      wslShellCommand: '"$(pick-rg)"'
    })

    expect(resolved.binary).toBe('wsl.exe')
    expect(resolved.args.at(-1)).toBe(`cd '/home/dev/repo' && "$(pick-rg)" '--files'`)
  })

  it('keeps bare commands quoted when no expression is given', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    const resolved = resolveCommand('rg', ['--files'], UNC_REPO)

    expect(resolved.args.at(-1)).toBe(`cd '/home/dev/repo' && 'rg' '--files'`)
  })
})
