import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveGitCommandWithoutProbe } from './git-command-resolution'
import {
  recordHostAutocrlf,
  recordLineEndingSample,
  resetWslWindowsCheckoutGitConfigForTests,
  wslWindowsCheckoutKey
} from '../../wsl-windows-checkout-git-config'
import { resetWslLinkedWorktreeGitRoutingForTests } from './wsl-linked-worktree-git-routing'

const originalPlatform = process.platform
const DRIVE_REPO = String.raw`C:\Users\dev\repo`

function detectWindowsCheckout(): void {
  const key = wslWindowsCheckoutKey(DRIVE_REPO, 'Ubuntu')
  recordHostAutocrlf(key, 'true', Date.now())
  recordLineEndingSample(key, 'windows', 'clone', Date.now())
}

describe('WSL git on a Windows Git checkout', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    resetWslWindowsCheckoutGitConfigForTests()
    resetWslLinkedWorktreeGitRoutingForTests()
  })

  it('runs WSL git with Windows Git line-ending and stat settings once detected', () => {
    detectWindowsCheckout()

    const resolved = resolveGitCommandWithoutProbe(['add', '--', 'a.ts'], {
      cwd: DRIVE_REPO,
      wslDistro: 'Ubuntu'
    })

    expect(resolved.binary).toBe('wsl.exe')
    expect(resolved.args.join(' ')).toMatch(/core\.autocrlf=true.+core\.checkStat=minimal.+add/)
    expect(resolved.args.join(' ')).not.toContain('trustctime')
  })
})
