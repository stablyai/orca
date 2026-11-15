import { basename } from 'node:path'
import { RuntimeClientError } from '../../runtime/connection/types'

export function resolveCompatibilityCliCommand(): 'orca' | 'orca-ide' | 'orca-dev' {
  const configured = process.env.ORCA_CLI_COMMAND
  if (configured === 'orca' || configured === 'orca-ide' || configured === 'orca-dev') {
    return configured
  }
  return process.platform === 'linux' ? 'orca-ide' : 'orca'
}

export function resolvePackagedWindowsCompatibilityCommand(): 'orca' | 'orca-ide' | undefined {
  if (process.env.ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER !== '1') {
    return undefined
  }
  const command = process.env.ORCA_CLI_COMMAND
  if (command === 'orca' || command === 'orca-ide') {
    return command
  }
  throw new RuntimeClientError(
    'invalid_argument',
    'The packaged Orca launcher did not provide a valid resume command. No question was created.'
  )
}

export async function flushOrchestrationStdout(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write('', (error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

export function isDevCliInvocation(): boolean {
  return (
    process.env.ORCA_DEV_CLI_INVOCATION === '1' ||
    (process.env.ORCA_USER_DATA_PATH?.includes('orca-dev') ?? false)
  )
}

// Linux desktop installs the app CLI as `orca-ide` (GNOME's screen reader owns `orca`), while
// Orca terminals advertise their shim via ORCA_CLI_COMMAND, dev launchers are `orca-dev`, and
// SSH/headless Node CLIs stay `orca`.
export function resolveInvokedCliCommand(): string {
  if (process.platform !== 'linux') {
    return 'orca'
  }
  const configured = process.env.ORCA_CLI_COMMAND?.trim()
  if (configured) {
    return basename(configured)
  }
  if (isDevCliInvocation()) {
    return 'orca-dev'
  }
  return process.env.ELECTRON_RUN_AS_NODE === '1' ? 'orca-ide' : 'orca'
}
