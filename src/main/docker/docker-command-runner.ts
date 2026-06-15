import { execFile } from 'node:child_process'
import type { DockerConnection, DockerContainerInspect, DockerContainerSummary, DockerSshTargetRef } from '../../shared/docker-types'
import { parseDockerContainers } from './docker-output-parser'
import { parseDockerInspect } from './docker-inspect-parser'

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
        throw new Error(`Docker connection "${conn.id}" is kind 'ssh' but no sshTarget was provided`)
      }
      const target = options.sshTarget
      const user = target.username ? `${target.username}@` : ''
      const port = target.port ? `:${target.port}` : ''
      return { file, args: dockerArgs, env: { DOCKER_HOST: `ssh://${user}${target.host}${port}` } }
    }
  }
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
      { env: { ...process.env, ...options.env }, timeout: options.timeout, windowsHide: true },
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
