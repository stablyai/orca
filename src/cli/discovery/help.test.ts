import { afterEach, expect, it, vi } from 'vitest'
import { validateCommandAndFlags } from '../arguments/args'
import { RuntimeClientError } from '../runtime/connection/types'
import { COMMAND_SPECS } from '../specs'
import { printHelp } from './help'

const platform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function renderHelp(commandPath: string[]): string {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  printHelp(COMMAND_SPECS, commandPath)
  const output = log.mock.calls.map((call) => String(call[0])).join('\n')
  log.mockRestore()
  return output
}

it('names the Linux app launcher orca-ide in help', () => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
  vi.stubEnv('ORCA_CLI_COMMAND', '')
  vi.stubEnv('ORCA_DEV_CLI_INVOCATION', '')
  vi.stubEnv('ORCA_USER_DATA_PATH', '/home/me/.config/Orca')

  const root = renderHelp([])
  expect(root).toContain('Usage: orca-ide <command> [options]')
  expect(root).toContain('$ orca-ide worktree create --repo name:orca --name cli-test-1')
  expect(renderHelp(['terminal'])).toContain('Usage: orca-ide terminal <command> [options]')
  expect(renderHelp(['terminal', 'list'])).toContain('Usage: orca-ide terminal list')
  expect(renderHelp(['nope'])).toMatch(
    /^Unknown command: nope\n[\s\S]*\n\norca-ide\n\nUsage: orca-ide <command>/
  )
})

it('names the Linux dev launcher orca-dev in help', () => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
  vi.stubEnv('ORCA_CLI_COMMAND', '')
  vi.stubEnv('ORCA_USER_DATA_PATH', '/home/me/.config/orca-dev')
  expect(renderHelp([])).toContain('Usage: orca-dev <command> [options]')
})

it('keeps orca for the Orca terminal shim and Node CLIs on SSH hosts', () => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
  vi.stubEnv('ORCA_CLI_COMMAND', '/home/me/.config/Orca/linux-orca-cli-shim/orca')
  expect(renderHelp([])).toContain('Usage: orca <command> [options]')

  vi.stubEnv('ELECTRON_RUN_AS_NODE', '')
  vi.stubEnv('ORCA_CLI_COMMAND', '')
  vi.stubEnv('ORCA_DEV_CLI_INVOCATION', '')
  vi.stubEnv('ORCA_USER_DATA_PATH', '/home/me/.local/share/orca-server')
  expect(renderHelp([])).toContain('Usage: orca <command> [options]')
})

function invalidCommandError(commandPath: string[]): RuntimeClientError {
  try {
    validateCommandAndFlags(COMMAND_SPECS, { commandPath, flags: new Map() })
  } catch (error) {
    if (error instanceof RuntimeClientError) {
      return error
    }
  }
  throw new Error(`expected ${commandPath.join(' ')} to be rejected`)
}

it('names orca-ide in Linux typo suggestions and missing-subcommand hints', () => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  vi.stubEnv('ORCA_CLI_COMMAND', 'orca-ide')

  expect(renderHelp(['wroktree'])).toMatch(
    /^Unknown command: wroktree\nNext step: Did you mean: orca-ide worktree\n/
  )
  expect(invalidCommandError(['wroktree']).data).toMatchObject({
    nextSteps: ['Did you mean: orca-ide worktree']
  })
  const missing = invalidCommandError(['terminal'])
  expect(missing.message).toBe('Missing subcommand for: orca-ide terminal')
  expect(missing.data).toMatchObject({
    nextSteps: ['Run `orca-ide terminal --help` to list its commands.']
  })
  expect(renderHelp(['orca'])).toMatch(/^Unknown command: orca\n/)
  expect(invalidCommandError(['orca']).message).toBe('Unknown command: orca')
})

it('keeps orca in macOS help, suggestions and hints', () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
  vi.stubEnv('ORCA_CLI_COMMAND', 'orca-ide')

  expect(renderHelp([])).toContain('Usage: orca <command> [options]')
  expect(renderHelp(['wroktree'])).toMatch(
    /^Unknown command: wroktree\nNext step: Did you mean: orca worktree\n/
  )
  const missing = invalidCommandError(['terminal'])
  expect(missing.message).toBe('Missing subcommand for: orca terminal')
  expect(missing.data).toMatchObject({
    nextSteps: ['Run `orca terminal --help` to list its commands.']
  })
})
