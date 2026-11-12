import { settleWslAutomountRoot } from '../../../wsl/filesystem/__fixtures__/wsl-automount-root-fixture'
import { resetWslAutomountRootsForTests } from '../../../wsl/filesystem/wsl-automount-root'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveGitCommandWithoutProbe } from './git-command-resolution'
import { captureGitExecutionContext } from './wsl-git-path-preparation'
import {
  recordHostAutocrlf,
  recordLineEndingSample,
  resetWslWindowsCheckoutGitConfigForTests,
  wslWindowsCheckoutKey
} from './wsl-windows-checkout-git-config'
import { resetWslLinkedWorktreeGitRoutingForTests } from './wsl-linked-worktree-git-routing'

const originalPlatform = process.platform
const DRIVE_REPO = String.raw`C:\Users\dev\repo`

function detectWindowsCheckout(): void {
  const key = wslWindowsCheckoutKey(DRIVE_REPO, 'Ubuntu')
  recordHostAutocrlf(key, 'true', Date.now())
  recordLineEndingSample(key, 'windows', 'clone', Date.now())
}

describe('WSL git on a Windows Git checkout', () => {
  beforeEach(async () => {
    resetWslAutomountRootsForTests()
    await settleWslAutomountRoot()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    resetWslAutomountRootsForTests()
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

  it('keeps a UNC clone destination on WSL when hostGit suppresses project routing', () => {
    const options = { cwd: String.raw`\\wsl.localhost\Ubuntu\home\me\src`, hostGit: true as const }
    const resolved = resolveGitCommandWithoutProbe(['clone', 'https://example.invalid/repo'], {
      ...options,
      executionContext: captureGitExecutionContext(options)
    })
    expect(resolved.binary).toBe('wsl.exe')
    expect(resolved.args.slice(0, 3)).toEqual(['-d', 'Ubuntu', '--exec'])
  })
})
