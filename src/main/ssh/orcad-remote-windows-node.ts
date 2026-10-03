/**
 * Running node.exe on a Windows orcad host straight from the SSH exec, with plain argv.
 *
 * sshd hands the command to its DefaultShell, cmd.exe on a stock install or PowerShell when an
 * admin sets it, and Orca does not probe which. So the line is built from the subset both parse
 * the same way: an unquoted executable path, then arguments that are bare or double-quoted and
 * contain nothing either shell expands (`%`, `$`, backtick, `"`). When the executable path
 * itself needs quoting (a profile with a space), the line falls back to one unencoded
 * `powershell.exe -Command`, which both shells pass through intact. Anything else is refused
 * rather than encoded (docs/reference/windows-edr-posture.md).
 */
import {
  ORCAD_NODE_RUNTIME_DIR_PREFIX,
  ORCAD_NODE_RUNTIME_WINDOWS_EXECUTABLE,
  ORCAD_RUNTIMES_DIRNAME
} from '../../shared/orcad-artifacts'
import { pinnedNodeRuntimeAsset, type NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import type { SshConnection } from './ssh-connection'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { joinRemotePath, remoteDirname, type RemoteHostPlatform } from './ssh-remote-platform'
import { powerShellLiteral } from './ssh-remote-powershell'
import {
  ORCAD_WINDOWS_HOST_SCRIPT,
  ORCAD_WINDOWS_HOST_SCRIPT_FILENAME,
  type OrcadWindowsHostOp
} from './orcad-windows-host-script'

const BARE_EXECUTABLE = /^[A-Za-z]:\\[A-Za-z0-9._+~\\-]*$/u
// Leading digits are quoted: PowerShell would read `1e5` as a number and pass `100000`.
const BARE_ARGUMENT = /^[A-Za-z-][A-Za-z0-9._:+=/\\-]*$/u
// Expanded by cmd.exe (`%`) or PowerShell (`$`, backtick, typographic quotes) inside "..."
const UNQUOTABLE = /["%$`\r\n“”„‘’‚‛]/u

export class OrcadWindowsCommandLineError extends Error {
  readonly code = 'orcad_windows_command_line_unsafe'
  constructor(value: string) {
    super(
      `Orca cannot pass ${JSON.stringify(value)} to node.exe on this Windows host: it contains ` +
        'a character cmd.exe or PowerShell would expand.'
    )
    this.name = 'OrcadWindowsCommandLineError'
  }
}

function windowsPath(value: string): string {
  return value.replace(/\//gu, '\\')
}

function quotedArgument(value: string): string {
  if (BARE_ARGUMENT.test(value)) {
    return value
  }
  // A trailing backslash would escape the closing quote for CommandLineToArgvW.
  if (value === '' || UNQUOTABLE.test(value) || value.endsWith('\\')) {
    throw new OrcadWindowsCommandLineError(value)
  }
  return `"${value}"`
}

/** One node.exe invocation that parses identically under cmd.exe and PowerShell. */
export function orcadWindowsNodeCommandLine(executable: string, args: readonly string[]): string {
  const program = windowsPath(executable)
  const argv = args.map(quotedArgument)
  if (BARE_EXECUTABLE.test(program)) {
    return [program, ...argv].join(' ')
  }
  // The inner line is single-quoted PowerShell inside one double-quoted argument both shells keep.
  for (const value of [program, ...args]) {
    if (UNQUOTABLE.test(value)) {
      throw new OrcadWindowsCommandLineError(value)
    }
  }
  const inner = ['&', ...[program, ...args].map(powerShellLiteral)].join(' ')
  return `powershell.exe -NoProfile -NonInteractive -Command "${inner}"`
}

/** `~/.orca-remote` from the remote home. */
export function orcadRemoteBaseDir(host: RemoteHostPlatform, remoteHome: string): string {
  return joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR)
}

/** `~/.orca-remote`, the parent of every slot and of the runtime store. */
export function orcadWindowsBaseDir(host: RemoteHostPlatform, slotDir: string): string {
  return remoteDirname(slotDir.replace(/\/+$/u, ''), host)
}

/** This client's pinned node.exe in the runtime store; deterministic from the host's arch. */
export function orcadWindowsPinnedNodePath(host: RemoteHostPlatform, baseDir: string): string {
  const target: NodeRuntimeTarget = host.arch === 'arm64' ? 'win32-arm64' : 'win32-x64'
  return joinRemotePath(
    host,
    baseDir,
    ORCAD_RUNTIMES_DIRNAME,
    `${ORCAD_NODE_RUNTIME_DIR_PREFIX}${pinnedNodeRuntimeAsset(target).executableSha256}`,
    ORCAD_NODE_RUNTIME_WINDOWS_EXECUTABLE
  )
}

export function orcadWindowsHostScriptPath(host: RemoteHostPlatform, baseDir: string): string {
  return joinRemotePath(host, baseDir, ORCAD_WINDOWS_HOST_SCRIPT_FILENAME)
}

/** `node.exe <host script> <op> <args>`, run by this client's pinned runtime. */
export function orcadWindowsHostOpCommand(
  host: RemoteHostPlatform,
  baseDir: string,
  op: OrcadWindowsHostOp,
  args: readonly string[]
): string {
  return orcadWindowsNodeCommandLine(orcadWindowsPinnedNodePath(host, baseDir), [
    orcadWindowsHostScriptPath(host, baseDir),
    op,
    ...args
  ])
}

/**
 * Stages the host script. One file write per lifecycle operation, before any host op: the
 * caller that resolves a Windows orcad context owns calling it.
 */
export async function installOrcadWindowsHostScript(
  target: { conn: SshConnection; host: RemoteHostPlatform; signal?: AbortSignal },
  baseDir: string
): Promise<void> {
  await target.conn.writeFile(
    orcadWindowsHostScriptPath(target.host, baseDir),
    ORCAD_WINDOWS_HOST_SCRIPT,
    { hostPlatform: target.host, signal: target.signal }
  )
}

/** The decoded payload after `marker`, or null when the host printed no such line. */
export function readOrcadWindowsEncodedAnswer(output: string, marker: string): string | null {
  const line = output
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .findLast((candidate) => candidate === marker || candidate.startsWith(`${marker} `))
  if (line === undefined) {
    return null
  }
  const encoded = line.slice(marker.length).trim()
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
    return null
  }
  return Buffer.from(encoded, 'base64').toString('utf8')
}
