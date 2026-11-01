import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { recordSubprocessSpawn } from '../../diagnostics/main-thread-churn-probe'
import {
  commandLineLength,
  MAX_COMMAND_LINE_CHARS,
  WindowsCommandLineBudgetError
} from '../../../shared/windows-command-line-budget'
import { resolveCommand, withWslPreparation } from './wsl-command-resolution'

export function wslAwareSpawn(
  command: string,
  args: string[],
  options: SpawnOptions & {
    cwd?: string
    wslDistro?: string
    useWslLoginShell?: boolean
    wslShellCommand?: string
    cwdFailureExitCode?: number
    preparation?: { script: string; args: string[] }
  }
): ChildProcess {
  const {
    wslDistro,
    useWslLoginShell,
    wslShellCommand,
    cwdFailureExitCode,
    preparation,
    ...spawnOptions
  } = options
  let resolved = resolveCommand(command, args, options.cwd, wslDistro, {
    useWslLoginShell,
    wslShellCommand,
    ...(cwdFailureExitCode === undefined ? {} : { cwdFailureExitCode })
  })
  if (preparation && resolved.wsl) {
    resolved = withWslPreparation(resolved, preparation)
    if (commandLineLength([resolved.binary, ...resolved.args]) > MAX_COMMAND_LINE_CHARS) {
      throw new WindowsCommandLineBudgetError()
    }
  }
  const spawnStartedAt = performance.now()
  const child = spawn(resolved.binary, resolved.args, {
    ...spawnOptions,
    windowsHide: true,
    cwd: resolved.cwd
  })
  recordSubprocessSpawn(resolved.binary, resolved.args, performance.now() - spawnStartedAt)
  return child
}
