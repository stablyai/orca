import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveGitCommand, resolveGitCommandWithoutProbe } from './git-command-resolution'
import {
  recordHostAutocrlf,
  recordLineEndingSample,
  resetWslWindowsCheckoutGitConfigForTests,
  wslWindowsCheckoutKey
} from '../wsl-windows-checkout-git-config'
import {
  resetWslLinkedWorktreeGitRoutingForTests,
  seedWslLinkedWorktreeGitRoutingForTests
} from '../wsl-linked-worktree-git-routing'
import { bulkPathspecCommands } from '../source-control/git-pathspec'
import {
  commandLineLength,
  MAX_COMMAND_LINE_CHARS
} from '../../../shared/windows-command-line-budget'

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

  it('leaves host-routed commands and undetected checkouts unchanged', () => {
    expect(
      resolveGitCommandWithoutProbe(['status'], { cwd: DRIVE_REPO, wslDistro: 'Ubuntu' }).args.join(
        ' '
      )
    ).not.toContain('core.autocrlf')

    detectWindowsCheckout()
    expect(resolveGitCommand(['status'], { cwd: DRIVE_REPO }).args).toEqual(['status'])

    seedWslLinkedWorktreeGitRoutingForTests(DRIVE_REPO)
    expect(resolveGitCommand(['status'], { cwd: DRIVE_REPO, wslDistro: 'Ubuntu' }).args).toEqual([
      'status'
    ])
  })

  it('keeps every bulk chunk under the command-line cap once the config is prepended', () => {
    const paths = Array.from({ length: 400 }, (_, index) => `src/${'deep/'.repeat(12)}f${index}.ts`)
    const chunks = bulkPathspecCommands(['add', '--'], paths, DRIVE_REPO, { wslDistro: 'Ubuntu' })
    detectWindowsCheckout()

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      const resolved = resolveGitCommandWithoutProbe(chunk, {
        cwd: DRIVE_REPO,
        wslDistro: 'Ubuntu'
      })
      expect(commandLineLength([resolved.binary, ...resolved.args])).toBeLessThanOrEqual(
        MAX_COMMAND_LINE_CHARS
      )
    }
  })
})
