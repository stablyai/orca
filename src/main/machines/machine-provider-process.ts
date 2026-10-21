import { StringDecoder } from 'node:string_decoder'
import { runProcess } from '@orca/process-host'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import {
  MACHINE_PROVIDER_ORCA_NODE,
  MACHINE_PROVIDER_PLUGIN_PATH_PREFIX,
  buildMachineProviderArgv,
  type MachineProviderVerb
} from '../../shared/machine-provider-command'
import {
  MACHINE_PROVIDER_PROTOCOL_VERSION,
  MachineProviderError,
  parseMachineProviderResponse,
  type MachineProviderRequest,
  type MachineProviderSuccess
} from '../../shared/machine-provider-protocol'
import { resolveContainedPluginArtifact } from '../plugins/plugin-artifact-validation'

const MAX_STDOUT_BYTES = 512 * 1024
const MAX_STDERR_TAIL_CHARS = 64 * 1024
const READ_TIMEOUT_MS = 20_000
const LIFECYCLE_TIMEOUT_MS = 180_000
const CREATE_TIMEOUT_MS = 15 * 60_000
// Hidden prompts can't be answered (no TTY), so fail on their text instead of waiting out a timeout.
const AUTH_REQUIRED_STDERR =
  /Permission denied|Host key verification failed|password:|passphrase|Too many authentication failures/i

const TIMEOUT_MS: Record<MachineProviderVerb, number> = {
  capabilities: READ_TIMEOUT_MS,
  list: READ_TIMEOUT_MS,
  get: READ_TIMEOUT_MS,
  sleep: LIFECYCLE_TIMEOUT_MS,
  wake: LIFECYCLE_TIMEOUT_MS,
  archive: LIFECYCLE_TIMEOUT_MS,
  delete: LIFECYCLE_TIMEOUT_MS,
  create: CREATE_TIMEOUT_MS
}

const READ_VERBS: ReadonlySet<MachineProviderVerb> = new Set(['capabilities', 'list', 'get'])

export type MachineProviderSource = {
  command: readonly string[]
  pluginRootDir: string
}

export type MachineProviderInvocation = {
  program: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export async function resolveMachineProviderInvocation(
  pluginRootDir: string,
  argv: readonly string[],
  options: { execPath: string; env: NodeJS.ProcessEnv }
): Promise<MachineProviderInvocation> {
  const resolved = await Promise.all(
    argv.map(async (value, index) =>
      index === 0 && value === MACHINE_PROVIDER_ORCA_NODE
        ? options.execPath
        : value.startsWith(MACHINE_PROVIDER_PLUGIN_PATH_PREFIX)
          ? resolveContainedPluginArtifact(
              pluginRootDir,
              value.slice(MACHINE_PROVIDER_PLUGIN_PATH_PREFIX.length)
            )
          : value
    )
  )
  const env: NodeJS.ProcessEnv = { ...options.env, SSH_ASKPASS_REQUIRE: 'never' }
  delete env.DISPLAY
  if (argv[0] === MACHINE_PROVIDER_ORCA_NODE) {
    env.ELECTRON_RUN_AS_NODE = '1'
  }
  const [program, ...args] = resolved
  return { program: program ?? '', args, env }
}

export type RunMachineProviderVerbArgs = {
  source: MachineProviderSource
  verb: MachineProviderVerb
  operationId: string
  machineId?: string
  contextId?: string
  params?: Record<string, unknown>
  /** Never the repo: on Windows a planted binary there would win bare-name resolution. */
  cwd: string
  execPath?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  /** Decoded stderr as it arrives, for progress; stdout may carry credentials and is never streamed. */
  onStderr?: (chunk: string) => void
  run?: (spec: ProcessSpec) => Promise<ProcessResult>
}

/** Runs one provider verb. Never retries: mutations are reconciled by the caller with a read. */
export async function runMachineProviderVerb(
  args: RunMachineProviderVerbArgs
): Promise<MachineProviderSuccess> {
  const request: MachineProviderRequest = {
    protocolVersion: MACHINE_PROVIDER_PROTOCOL_VERSION,
    operationId: args.operationId,
    verb: args.verb,
    ...(args.contextId !== undefined ? { contextId: args.contextId } : {}),
    ...(args.machineId !== undefined ? { machineId: args.machineId } : {}),
    ...(args.params !== undefined ? { params: args.params } : {})
  }
  const argv = buildMachineProviderArgv(args.source.command, args.verb, args.machineId)
  const invocation = await resolveMachineProviderInvocation(args.source.pluginRootDir, argv, {
    execPath: args.execPath ?? process.execPath,
    env: args.env ?? process.env
  })
  const isRead = READ_VERBS.has(args.verb)
  let result: ProcessResult
  try {
    result = await (args.run ?? runProcess)({
      program: invocation.program,
      args: invocation.args,
      cwd: args.cwd,
      env: invocation.env,
      input: JSON.stringify(request),
      timeoutMs: TIMEOUT_MS[args.verb],
      maxOutputBytes: MAX_STDOUT_BYTES,
      killOnOutputLimit: true,
      signal: args.signal,
      ...(args.onStderr ? { onStderr: decodeChunks(args.onStderr) } : {})
    })
  } catch (error) {
    throw new MachineProviderError(
      'unavailable',
      `Could not start ${args.source.command[0]}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (args.signal?.aborted) {
    throw new MachineProviderError('cancelled', `${args.verb} was cancelled.`)
  }
  const stderr = result.stderr.slice(-MAX_STDERR_TAIL_CHARS)
  if (result.timedOut) {
    throw new MachineProviderError(
      isRead ? 'unavailable' : 'timeout',
      `${args.verb} did not finish within ${TIMEOUT_MS[args.verb] / 1000}s.`
    )
  }
  if (result.outputTruncated) {
    throw new MachineProviderError('invalid-response', 'The provider output exceeded the limit.')
  }
  const response = parseResponse(result, stderr, request)
  if (response.kind === 'error') {
    throw new MachineProviderError(response.code, response.message)
  }
  return response
}

function parseResponse(
  result: ProcessResult,
  stderr: string,
  request: MachineProviderRequest
): ReturnType<typeof parseMachineProviderResponse> {
  if (result.code === 0) {
    return parseMachineProviderResponse(result.stdout, request)
  }
  // A failing provider may still print a structured error; prefer it over stderr heuristics.
  try {
    const response = parseMachineProviderResponse(result.stdout, request)
    if (response.kind === 'error') {
      return response
    }
  } catch (error) {
    // A well-formed answer from the wrong account or a newer protocol is not a transport failure.
    if (
      error instanceof MachineProviderError &&
      (error.code === 'context-mismatch' || error.code === 'protocol-unsupported')
    ) {
      throw error
    }
  }
  if (AUTH_REQUIRED_STDERR.test(stderr)) {
    throw new MachineProviderError('auth-required', lastLine(stderr))
  }
  throw new MachineProviderError(
    'unavailable',
    lastLine(stderr) ||
      `The provider exited with code ${result.code ?? result.signal ?? 'unknown'}.`
  )
}

// One decoder per run, so a multi-byte character split across chunks is not mangled.
function decodeChunks(forward: (chunk: string) => void): (chunk: Buffer | string) => void {
  const decoder = new StringDecoder('utf8')
  return (chunk) => {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
    if (text) {
      forward(text)
    }
  }
}

function lastLine(text: string): string {
  const lines = text.trim().split(/\r?\n/)
  return (lines.at(-1) ?? '').slice(0, 1024)
}
