import { assertSafeRemotePathSegment, normalizeWindowsRemotePath } from './ssh-remote-platform'
import { powerShellCommand } from './ssh-remote-powershell'
import {
  openSshRelayRuntimeCommandFileDestination,
  type SshRelayRuntimeCommandFileChannel
} from './ssh-relay-runtime-command-file-destination'

export type SshRelayRuntimeWindowsStagingOperation =
  | 'create-root'
  | 'create-directory'
  | 'remove-root'

export type RunSshRelayRuntimeWindowsStagingControlOptions = Readonly<{
  operation: SshRelayRuntimeWindowsStagingOperation
  remoteRoot: string
  remotePath?: string
  signal: AbortSignal
  openChannel: (command: string, signal: AbortSignal) => Promise<SshRelayRuntimeCommandFileChannel>
}>

const REQUEST_MAGIC = Buffer.from('ORCACTL1', 'ascii')
const COMPLETION_MAGIC = Buffer.from('ORCAEND1', 'ascii')
const FIXED_REQUEST_BYTES = 20
const MAXIMUM_PATH_BYTES = 32 * 1024
const COMMAND_TIMEOUT_MS = 30_000

const OPERATION_CODES: Record<SshRelayRuntimeWindowsStagingOperation, number> = {
  'create-root': 1,
  'create-directory': 2,
  'remove-root': 3
}

export const SSH_RELAY_RUNTIME_WINDOWS_STAGING_CONTROL_LIMITS = Object.freeze({
  commandTimeoutMs: COMMAND_TIMEOUT_MS,
  maximumPathBytes: MAXIMUM_PATH_BYTES,
  maximumRequestBytes: FIXED_REQUEST_BYTES + MAXIMUM_PATH_BYTES * 2 + COMPLETION_MAGIC.length,
  completionBytes: COMPLETION_MAGIC.length
})

const RECEIVER_SCRIPT = `
$ErrorActionPreference = 'Stop'
function Read-Exact([System.IO.Stream]$Stream, [byte[]]$Buffer, [int]$Count) {
  $offset = 0
  while ($offset -lt $Count) {
    $read = $Stream.Read($Buffer, $offset, $Count - $offset)
    if ($read -eq 0) { throw 'SSH relay runtime Windows staging control early EOF' }
    $offset += $read
  }
}
$inputStream = [Console]::OpenStandardInput()
try {
  [byte[]]$header = New-Object byte[] ${FIXED_REQUEST_BYTES}
  Read-Exact $inputStream $header ${FIXED_REQUEST_BYTES}
  if ([Text.Encoding]::ASCII.GetString($header, 0, 8) -ne 'ORCACTL1') { throw 'bad header' }
  [byte]$operation = $header[8]
  if ($header[9] -ne 0 -or $header[10] -ne 0 -or $header[11] -ne 0) { throw 'bad reserved bytes' }
  [uint32]$rootLength = [BitConverter]::ToUInt32($header, 12)
  [uint32]$pathLength = [BitConverter]::ToUInt32($header, 16)
  if ($rootLength -eq 0 -or $rootLength -gt ${MAXIMUM_PATH_BYTES}) { throw 'bad root length' }
  if ($pathLength -gt ${MAXIMUM_PATH_BYTES}) { throw 'bad path length' }
  if (($operation -eq 2 -and $pathLength -eq 0) -or ($operation -ne 2 -and $pathLength -ne 0)) { throw 'bad operation path' }
  if ($operation -lt 1 -or $operation -gt 3) { throw 'bad operation' }
  [byte[]]$rootBytes = New-Object byte[] ([int]$rootLength)
  [byte[]]$pathBytes = New-Object byte[] ([int]$pathLength)
  Read-Exact $inputStream $rootBytes ([int]$rootLength)
  Read-Exact $inputStream $pathBytes ([int]$pathLength)
  [byte[]]$completion = New-Object byte[] ${COMPLETION_MAGIC.length}
  Read-Exact $inputStream $completion ${COMPLETION_MAGIC.length}
  if ([Text.Encoding]::ASCII.GetString($completion) -ne 'ORCAEND1') { throw 'bad completion' }
  $utf8 = New-Object Text.UTF8Encoding($false, $true)
  $root = $utf8.GetString($rootBytes)
  $path = if ($pathLength -eq 0) { '' } else { $utf8.GetString($pathBytes) }
  if (-not [IO.Path]::IsPathRooted($root) -or $root.IndexOf([char]0) -ge 0) { throw 'bad root' }
  if ($operation -eq 2) {
    if (-not [IO.Path]::IsPathRooted($path) -or $path.IndexOf([char]0) -ge 0 -or -not $path.StartsWith($root + '/', [StringComparison]::Ordinal)) { throw 'bad child path' }
  }
  switch ($operation) {
    1 {
      $parent = [IO.Path]::GetDirectoryName($root)
      if ([string]::IsNullOrEmpty($parent) -or -not [IO.Directory]::Exists($parent)) { throw 'missing root parent' }
      New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
    }
    2 {
      $parent = [IO.Path]::GetDirectoryName($path)
      if ([string]::IsNullOrEmpty($parent) -or -not [IO.Directory]::Exists($parent)) { throw 'missing directory parent' }
      New-Item -ItemType Directory -Path $path -ErrorAction Stop | Out-Null
    }
    3 {
      if ([IO.File]::Exists($root)) { throw 'staging root became a file' }
      if ([IO.Directory]::Exists($root)) { [IO.Directory]::Delete($root, $true) }
    }
  }
} catch {
  throw 'SSH relay runtime Windows staging control failed'
}
`.trim()

const RECEIVER_COMMAND = powerShellCommand(RECEIVER_SCRIPT)

function normalizeAbsolutePath(value: string): string {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.includes('\0') ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    throw new Error('SSH relay runtime Windows staging control path is invalid')
  }
  const normalized = normalizeWindowsRemotePath(value)
  const driveRooted = /^[A-Za-z]:\//u.test(normalized)
  const uncRooted = /^\/\/[^/]+\/[^/]+\//u.test(normalized)
  if ((!driveRooted && !uncRooted) || normalized.endsWith('/')) {
    throw new Error('SSH relay runtime Windows staging control path is invalid')
  }
  const segments = driveRooted ? normalized.slice(3).split('/') : normalized.slice(2).split('/')
  try {
    for (const segment of segments) {
      assertSafeRemotePathSegment(segment, 'windows')
    }
  } catch {
    throw new Error('SSH relay runtime Windows staging control path is invalid')
  }
  if (Buffer.byteLength(normalized, 'utf8') > MAXIMUM_PATH_BYTES) {
    throw new Error('SSH relay runtime Windows staging control path is invalid')
  }
  return normalized
}

function validateOptions(options: RunSshRelayRuntimeWindowsStagingControlOptions): {
  operation: SshRelayRuntimeWindowsStagingOperation
  remoteRoot: string
  remotePath: string
} {
  if (
    !options ||
    typeof options.operation !== 'string' ||
    !Object.hasOwn(OPERATION_CODES, options.operation) ||
    !options.signal ||
    typeof options.openChannel !== 'function'
  ) {
    throw new Error('SSH relay runtime Windows staging control input is invalid')
  }
  const remoteRoot = normalizeAbsolutePath(options.remoteRoot)
  if (options.operation !== 'create-directory') {
    if (options.remotePath !== undefined) {
      throw new Error('SSH relay runtime Windows staging control input is invalid')
    }
    return { operation: options.operation, remoteRoot, remotePath: '' }
  }
  const remotePath = normalizeAbsolutePath(options.remotePath as string)
  // Why: control requests may create only a strict descendant of the root owned by the tree caller.
  if (!remotePath.startsWith(`${remoteRoot}/`)) {
    throw new Error('SSH relay runtime Windows staging control path is invalid')
  }
  return { operation: options.operation, remoteRoot, remotePath }
}

function buildRequest(
  operation: SshRelayRuntimeWindowsStagingOperation,
  remoteRoot: string,
  remotePath: string
): Buffer {
  const rootBytes = Buffer.from(remoteRoot, 'utf8')
  const pathBytes = Buffer.from(remotePath, 'utf8')
  const request = Buffer.alloc(
    FIXED_REQUEST_BYTES + rootBytes.length + pathBytes.length + COMPLETION_MAGIC.length
  )
  REQUEST_MAGIC.copy(request, 0)
  request.writeUInt8(OPERATION_CODES[operation], 8)
  request.writeUInt32LE(rootBytes.length, 12)
  request.writeUInt32LE(pathBytes.length, 16)
  rootBytes.copy(request, FIXED_REQUEST_BYTES)
  pathBytes.copy(request, FIXED_REQUEST_BYTES + rootBytes.length)
  COMPLETION_MAGIC.copy(request, FIXED_REQUEST_BYTES + rootBytes.length + pathBytes.length)
  return request
}

export async function runSshRelayRuntimeWindowsStagingControl(
  options: RunSshRelayRuntimeWindowsStagingControlOptions
): Promise<void> {
  const { operation, remoteRoot, remotePath } = validateOptions(options)
  const request = buildRequest(operation, remoteRoot, remotePath)
  const commandController = new AbortController()
  const onCallerAbort = (): void => commandController.abort(options.signal.reason)
  options.signal.addEventListener('abort', onCallerAbort, { once: true })
  if (options.signal.aborted) {
    onCallerAbort()
  }
  const timeout = setTimeout(
    () => commandController.abort(new Error('SSH relay runtime Windows staging control timed out')),
    COMMAND_TIMEOUT_MS
  )
  try {
    const destination = await openSshRelayRuntimeCommandFileDestination({
      command: RECEIVER_COMMAND,
      fileKind: 'Windows',
      signal: commandController.signal,
      openChannel: options.openChannel
    })
    try {
      await destination.write(request)
      await destination.close()
    } catch (error) {
      try {
        // Why: a retained request buffer must settle before this bounded control operation returns.
        await destination.abort(error)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'SSH relay runtime Windows staging control cleanup failed'
        )
      }
      throw error
    }
  } finally {
    clearTimeout(timeout)
    options.signal.removeEventListener('abort', onCallerAbort)
  }
}
