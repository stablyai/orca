import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getSpawnArgsForWindows,
  wrapWindowsStartWait
} from '../../../../shared/shell/launch/windows-batch-spawn'
import { getSystem32ExePath } from '../../../windows/windows-command-paths'

export type WindowsHostInteractiveLoginSpawn = {
  command: string
  args: string[]
  stdio: 'ignore'
  windowsHide: boolean
  /** Best effort; never rejects. */
  cleanup: () => Promise<void>
  getTerminationPid: () => number | null
  waitForTerminationPid: () => Promise<number | null>
  /** The login's own exit code; `start /wait` always exits 0, so read this instead. */
  readExitCode: () => Promise<number | null>
}

const PID_RELAY_WAIT_TIMEOUT_MS = 2_000
const PID_RELAY_POLL_INTERVAL_MS = 25

function encodeUtf8(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

function buildPidRelayScript(
  command: string,
  args: string[],
  pidFilePath: string,
  exitCodeFilePath: string
): string {
  const decode =
    'function Read-OrcaValue([string]$Value) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value)) }'
  const encodedArgs = args.map((arg) => `(Read-OrcaValue '${encodeUtf8(arg)}')`).join(',')
  return [
    decode,
    `$Command = Read-OrcaValue '${encodeUtf8(command)}'`,
    `$Arguments = @(${encodedArgs})`,
    `[IO.File]::WriteAllText((Read-OrcaValue '${encodeUtf8(pidFilePath)}'), [string]$PID)`,
    '& $Command @Arguments',
    '$OrcaExitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }',
    `[IO.File]::WriteAllText((Read-OrcaValue '${encodeUtf8(exitCodeFilePath)}'), [string]$OrcaExitCode)`,
    'exit $OrcaExitCode'
  ].join('; ')
}

function parseRelayInteger(text: string): number | null {
  const value = Number.parseInt(text.trim(), 10)
  return Number.isSafeInteger(value) ? value : null
}

function readPidFile(pidFilePath: string): number | null {
  try {
    const pid = parseRelayInteger(readFileSync(pidFilePath, 'utf8'))
    return pid !== null && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function readRelayInteger(filePath: string): Promise<number | null> {
  return readFile(filePath, 'utf8').then(parseRelayInteger, () => null)
}

async function removeRelayFiles(filePaths: string[]): Promise<void> {
  await Promise.all(filePaths.map((filePath) => rm(filePath, { force: true }).catch(() => {})))
}

function waitForPidFile(pidFilePath: string): Promise<number | null> {
  const current = readPidFile(pidFilePath)
  if (current !== null) {
    return Promise.resolve(current)
  }
  const deadline = Date.now() + PID_RELAY_WAIT_TIMEOUT_MS
  return new Promise((resolve) => {
    const poll = (): void => {
      const pid = readPidFile(pidFilePath)
      if (pid !== null || Date.now() >= deadline) {
        resolve(pid)
        return
      }
      setTimeout(poll, PID_RELAY_POLL_INTERVAL_MS)
    }
    setTimeout(poll, PID_RELAY_POLL_INTERVAL_MS)
  })
}

export function buildWindowsHostInteractiveLoginSpawn(
  command: string,
  args: string[]
): WindowsHostInteractiveLoginSpawn {
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(command, args)
  const relayId = randomUUID()
  const pidFilePath = join(tmpdir(), `orca-interactive-login-${relayId}.pid`)
  const exitCodeFilePath = join(tmpdir(), `orca-interactive-login-${relayId}.exit`)
  const powershell = getSystem32ExePath('WindowsPowerShell\\v1.0\\powershell.exe')
  const script = buildPidRelayScript(spawnCmd, spawnArgs, pidFilePath, exitCodeFilePath)
  // EncodedCommand needs no execution-policy override, so omit noisy no-op Bypass. Keep base64: start reparses via cmd, whose guard rejects the raw script’s metacharacters.
  const wrapped = wrapWindowsStartWait(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')
  ])
  return {
    command: wrapped.spawnCmd,
    args: wrapped.spawnArgs,
    stdio: 'ignore',
    windowsHide: true,
    cleanup: () => removeRelayFiles([pidFilePath, exitCodeFilePath]),
    getTerminationPid: () => readPidFile(pidFilePath),
    waitForTerminationPid: () => waitForPidFile(pidFilePath),
    readExitCode: () => readRelayInteger(exitCodeFilePath)
  }
}
