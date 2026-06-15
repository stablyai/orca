import type { DockerConnection, DockerSshTargetRef } from '../../shared/docker-types'

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
