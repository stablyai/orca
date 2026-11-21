import type * as ChildProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { withPlatform } from './commit-message-text-generation-test-harness'
import { spawnSourceControlAgent } from './source-control-agent-launch'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcess>()
  return { ...actual, spawn: spawnMock }
})
vi.mock('../../wsl/discovery/wsl-background-distro-gate', () => ({
  noteWslDistroLaunched: vi.fn()
}))

it('forwards launch and account env into a UNC WSL guest', () => {
  let args: readonly string[] = []
  let env: NodeJS.ProcessEnv | undefined
  spawnMock.mockImplementation(
    (_program: string, spawnArgs: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      args = spawnArgs
      env = options.env
      return new EventEmitter()
    }
  )
  withPlatform('win32', () =>
    spawnSourceControlAgent({
      binary: 'claude',
      args: ['models'],
      cwd: String.raw`\\wsl.localhost\Debian\home\dev\repo`,
      wslDistro: 'Debian',
      env: {
        ANTHROPIC_BASE_URL: 'https://gateway.example',
        CLAUDE_CONFIG_DIR: '/home/dev/.claude',
        ANTHROPIC_CUSTOM_HEADERS: '',
        WIN_ONLY: String.raw`C:\Users\dev\.claude`
      },
      stdinMode: 'ignore',
      useCwdForNative: false
    })
  )
  const command = args.join('\n')
  const wslenv = env?.WSLENV ?? ''
  expect(command).toContain('-d')
  expect(command).toContain('Debian')
  expect(wslenv).toContain('ANTHROPIC_BASE_URL/u')
  expect(wslenv).toContain('CLAUDE_CONFIG_DIR/u')
  expect(wslenv).toContain('ANTHROPIC_CUSTOM_HEADERS/u')
  expect(wslenv).toContain('WIN_ONLY/p')
  expect(env?.ANTHROPIC_BASE_URL).toBe('https://gateway.example')
  expect(env?.CLAUDE_CONFIG_DIR).toBe('/home/dev/.claude')
  expect(env?.ANTHROPIC_CUSTOM_HEADERS).toBe('')
  expect(command).toContain("export ANTHROPIC_BASE_URL='\\''https://gateway.example'\\''")
  expect(command).toContain("export CLAUDE_CONFIG_DIR='\\''/home/dev/.claude'\\''")
  expect(command).toContain("export ANTHROPIC_CUSTOM_HEADERS='\\'''\\''")
  expect(command).not.toContain(String.raw`WIN_ONLY=C:\Users\dev\.claude`)
})

it('forwards an override that matches the Windows parent and keeps one WSLENV entry', () => {
  vi.stubEnv('ANTHROPIC_BASE_URL', 'https://gateway.example')
  vi.stubEnv('WSLENV', 'win_only/w:KEEP/u')
  let args: readonly string[] = []
  let env: NodeJS.ProcessEnv | undefined
  spawnMock.mockImplementation(
    (_program: string, spawnArgs: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      args = spawnArgs
      env = options.env
      return new EventEmitter()
    }
  )
  try {
    withPlatform('win32', () =>
      spawnSourceControlAgent({
        binary: 'claude',
        args: ['models'],
        cwd: String.raw`\\wsl.localhost\Debian\home\dev\repo`,
        wslDistro: 'Debian',
        env: {
          ANTHROPIC_BASE_URL: 'https://gateway.example',
          WIN_ONLY: String.raw`C:\Users\dev\.claude`,
          ANTHROPIC_CUSTOM_HEADERS: 'Header-A: 1\nHeader-B: 2'
        },
        guestOverrides: {
          ANTHROPIC_BASE_URL: 'https://gateway.example',
          WIN_ONLY: String.raw`C:\Users\dev\.claude`,
          ANTHROPIC_CUSTOM_HEADERS: 'Header-A: 1\nHeader-B: 2'
        },
        stdinMode: 'ignore',
        useCwdForNative: false
      })
    )
  } finally {
    vi.unstubAllEnvs()
  }
  const command = args.join('\n')
  const wslenv = env?.WSLENV ?? ''
  const winOnly = wslenv.split(':').filter((token) => token.toUpperCase().startsWith('WIN_ONLY'))
  expect(winOnly).toEqual(['WIN_ONLY/p'])
  expect(wslenv).toContain('KEEP/u')
  expect(wslenv).toContain('ANTHROPIC_BASE_URL/u')
  expect(env?.ANTHROPIC_BASE_URL).toBe('https://gateway.example')
  expect(command).toContain('export ANTHROPIC_BASE_URL=')
  expect(command).toContain('Header-A: 1')
  expect(command).toContain('Header-B: 2')
  expect(wslenv).toContain('ANTHROPIC_CUSTOM_HEADERS/u')
})
