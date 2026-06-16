import { execFile } from 'node:child_process'
import type {
  DockerConnection,
  DockerContainerAction,
  DockerContainerInspect,
  DockerContainerSummary,
  DockerImageSummary,
  DockerNetworkSummary,
  DockerResourceKind,
  DockerSshTargetRef,
  DockerVolumeSummary
} from '../../shared/docker-types'
import { parseDockerContainers } from './docker-output-parser'
import { parseDockerInspect } from './docker-inspect-parser'
import {
  parseDockerImages,
  parseDockerNetworks,
  parseDockerVolumes
} from './docker-resource-parsers'

export const DOCKER_COMMAND_TIMEOUT_MS = 15_000

export type DockerInvocation = {
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export type BuildInvocationOptions = {
  dockerBinary?: string
  /** Required for kind === 'ssh'; resolved from the referenced SshTarget by the caller. */
  sshTarget?: DockerSshTargetRef
}

export function defaultDockerBinary(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'docker.exe' : 'docker'
}

/**
 * Build the local `execFile` invocation for a docker command. SSH connections use
 * docker's built-in `DOCKER_HOST=ssh://` transport (the spec's documented fallback),
 * so every captured command runs as a local child process in this foundation.
 */
export function buildInvocation(
  conn: DockerConnection,
  dockerArgs: string[],
  options: BuildInvocationOptions = {}
): DockerInvocation {
  const file = options.dockerBinary ?? defaultDockerBinary()
  switch (conn.kind) {
    case 'local':
      return { file, args: dockerArgs, env: {} }
    case 'tcp': {
      if (!conn.tcp) {
        throw new Error(`Docker connection "${conn.id}" is kind 'tcp' but has no tcp config`)
      }
      const host = `tcp://${conn.tcp.host}:${conn.tcp.port}`
      const env: NodeJS.ProcessEnv = conn.tcp.tls ? { DOCKER_TLS_VERIFY: '1' } : {}
      return { file, args: ['-H', host, ...dockerArgs], env }
    }
    case 'ssh': {
      if (!options.sshTarget) {
        throw new Error(
          `Docker connection "${conn.id}" is kind 'ssh' but no sshTarget was provided`
        )
      }
      const target = options.sshTarget
      const user = target.username ? `${target.username}@` : ''
      const port = target.port ? `:${target.port}` : ''
      return { file, args: dockerArgs, env: { DOCKER_HOST: `ssh://${user}${target.host}${port}` } }
    }
  }
}

const INHERITED_DOCKER_ENV_KEYS = [
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH'
] as const

// Why: a stray DOCKER_HOST/CONTEXT in the user's shell env must not silently
// redirect the built-in "Local" (or a TCP) connection to a different daemon.
// Our per-connection env (set by buildInvocation) is overlaid afterward and still wins.
export function sanitizedBaseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of INHERITED_DOCKER_ENV_KEYS) {
    delete env[key]
  }
  return env
}

export class DockerCommandError extends Error {
  constructor(
    readonly code: number,
    readonly stderr: string
  ) {
    super(stderr.trim() || `docker exited with code ${code}`)
    this.name = 'DockerCommandError'
  }
}

export type CapturedExecResult = { stdout: string; stderr: string; code: number }

export type CapturedExec = (
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeout?: number }
) => Promise<CapturedExecResult>

export type DockerRunnerDeps = {
  exec?: CapturedExec
  dockerBinary?: string
  sshTarget?: DockerSshTargetRef
}

/** Default executor: a local child process. Never throws on non-zero exit — returns the code. */
export const localCapturedExec: CapturedExec = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        env: { ...sanitizedBaseEnv(), ...options.env },
        timeout: options.timeout,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        // execFile sets error.code to the numeric exit code on a non-zero exit,
        // or a string (e.g. 'ENOENT'/timeout) on a spawn failure — map the latter to 1.
        const err = error as (NodeJS.ErrnoException & { code?: number | string }) | null
        const code = err == null ? 0 : typeof err.code === 'number' ? err.code : 1
        resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code })
      }
    )
  })

export async function listContainers(
  conn: DockerConnection,
  deps: DockerRunnerDeps = {}
): Promise<DockerContainerSummary[]> {
  const exec = deps.exec ?? localCapturedExec
  const invocation = buildInvocation(conn, ['ps', '-a', '--format', '{{json .}}'], {
    dockerBinary: deps.dockerBinary,
    sshTarget: deps.sshTarget
  })
  const result = await exec(invocation.file, invocation.args, {
    env: invocation.env,
    timeout: DOCKER_COMMAND_TIMEOUT_MS
  })
  if (result.code !== 0) {
    throw new DockerCommandError(result.code, result.stderr)
  }
  return parseDockerContainers(result.stdout)
}

export async function inspectContainer(
  conn: DockerConnection,
  containerId: string,
  deps: DockerRunnerDeps = {}
): Promise<DockerContainerInspect> {
  const exec = deps.exec ?? localCapturedExec
  const invocation = buildInvocation(conn, ['inspect', containerId], {
    dockerBinary: deps.dockerBinary,
    sshTarget: deps.sshTarget
  })
  const result = await exec(invocation.file, invocation.args, {
    env: invocation.env,
    timeout: DOCKER_COMMAND_TIMEOUT_MS
  })
  if (result.code !== 0) {
    throw new DockerCommandError(result.code, result.stderr)
  }
  const inspect = parseDockerInspect(result.stdout)
  if (!inspect) {
    throw new DockerCommandError(result.code, `Unexpected docker inspect output for ${containerId}`)
  }
  return inspect
}

function actionToArgs(action: DockerContainerAction, containerId: string): string[] {
  switch (action) {
    case 'start':
      return ['start', containerId]
    case 'stop':
      return ['stop', containerId]
    case 'restart':
      return ['restart', containerId]
    case 'pause':
      return ['pause', containerId]
    case 'unpause':
      return ['unpause', containerId]
    case 'remove':
      // -f so removing a running container doesn't error; the UI confirms first.
      return ['rm', '-f', containerId]
  }
}

export async function runContainerAction(
  conn: DockerConnection,
  containerId: string,
  action: DockerContainerAction,
  deps: DockerRunnerDeps = {}
): Promise<void> {
  const exec = deps.exec ?? localCapturedExec
  const invocation = buildInvocation(conn, actionToArgs(action, containerId), {
    dockerBinary: deps.dockerBinary,
    sshTarget: deps.sshTarget
  })
  const result = await exec(invocation.file, invocation.args, {
    env: invocation.env,
    timeout: DOCKER_COMMAND_TIMEOUT_MS
  })
  if (result.code !== 0) {
    throw new DockerCommandError(result.code, result.stderr)
  }
}

async function listResource<T>(
  conn: DockerConnection,
  args: string[],
  parse: (stdout: string) => T,
  deps: DockerRunnerDeps
): Promise<T> {
  const exec = deps.exec ?? localCapturedExec
  const invocation = buildInvocation(conn, args, {
    dockerBinary: deps.dockerBinary,
    sshTarget: deps.sshTarget
  })
  const result = await exec(invocation.file, invocation.args, {
    env: invocation.env,
    timeout: DOCKER_COMMAND_TIMEOUT_MS
  })
  if (result.code !== 0) {
    throw new DockerCommandError(result.code, result.stderr)
  }
  return parse(result.stdout)
}

export function listImages(
  conn: DockerConnection,
  deps: DockerRunnerDeps = {}
): Promise<DockerImageSummary[]> {
  return listResource(conn, ['images', '--format', '{{json .}}'], parseDockerImages, deps)
}

export function listVolumes(
  conn: DockerConnection,
  deps: DockerRunnerDeps = {}
): Promise<DockerVolumeSummary[]> {
  return listResource(conn, ['volume', 'ls', '--format', '{{json .}}'], parseDockerVolumes, deps)
}

export function listNetworks(
  conn: DockerConnection,
  deps: DockerRunnerDeps = {}
): Promise<DockerNetworkSummary[]> {
  return listResource(conn, ['network', 'ls', '--format', '{{json .}}'], parseDockerNetworks, deps)
}

function removeArgs(kind: DockerResourceKind, id: string): string[] {
  switch (kind) {
    case 'container':
      return ['rm', '-f', id]
    case 'image':
      return ['rmi', id]
    case 'volume':
      return ['volume', 'rm', id]
    case 'network':
      return ['network', 'rm', id]
  }
}

function pruneArgs(kind: DockerResourceKind): string[] {
  switch (kind) {
    case 'container':
      return ['container', 'prune', '-f']
    case 'image':
      return ['image', 'prune', '-f']
    case 'volume':
      return ['volume', 'prune', '-f']
    case 'network':
      return ['network', 'prune', '-f']
  }
}

async function runVoidCommand(
  conn: DockerConnection,
  args: string[],
  deps: DockerRunnerDeps
): Promise<void> {
  const exec = deps.exec ?? localCapturedExec
  const invocation = buildInvocation(conn, args, {
    dockerBinary: deps.dockerBinary,
    sshTarget: deps.sshTarget
  })
  const result = await exec(invocation.file, invocation.args, {
    env: invocation.env,
    timeout: DOCKER_COMMAND_TIMEOUT_MS
  })
  if (result.code !== 0) {
    throw new DockerCommandError(result.code, result.stderr)
  }
}

export function runResourceRemove(
  conn: DockerConnection,
  kind: DockerResourceKind,
  id: string,
  deps: DockerRunnerDeps = {}
): Promise<void> {
  return runVoidCommand(conn, removeArgs(kind, id), deps)
}

export function runResourcePrune(
  conn: DockerConnection,
  kind: DockerResourceKind,
  deps: DockerRunnerDeps = {}
): Promise<void> {
  return runVoidCommand(conn, pruneArgs(kind), deps)
}
