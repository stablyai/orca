import { describe, expect, it } from 'vitest'
import type { DockerConnection } from '../../shared/docker-types'
import { buildInvocation, defaultDockerBinary, listContainers, DockerCommandError, inspectContainer } from './docker-command-runner'

const ARGS = ['ps', '-a', '--format', '{{json .}}']

describe('buildInvocation', () => {
  it('runs the local binary directly with no extra env', () => {
    const conn: DockerConnection = { id: 'local', label: 'Local', kind: 'local' }
    expect(buildInvocation(conn, ARGS)).toEqual({ file: 'docker', args: ARGS, env: {} })
  })

  it('targets a tcp daemon with -H and sets TLS verify when configured', () => {
    const conn: DockerConnection = {
      id: 'c1',
      label: 'CI',
      kind: 'tcp',
      tcp: { host: '10.0.0.5', port: 2376, tls: {} }
    }
    expect(buildInvocation(conn, ARGS)).toEqual({
      file: 'docker',
      args: ['-H', 'tcp://10.0.0.5:2376', ...ARGS],
      env: { DOCKER_TLS_VERIFY: '1' }
    })
  })

  it('targets an ssh daemon via DOCKER_HOST built from the SshTarget', () => {
    const conn: DockerConnection = { id: 'c2', label: 'Box', kind: 'ssh', sshTargetId: 't1' }
    const result = buildInvocation(conn, ARGS, {
      sshTarget: { host: 'host.example', port: 2222, username: 'deploy' }
    })
    expect(result).toEqual({
      file: 'docker',
      args: ARGS,
      env: { DOCKER_HOST: 'ssh://deploy@host.example:2222' }
    })
  })

  it('honors a docker binary override', () => {
    const conn: DockerConnection = { id: 'local', label: 'Local', kind: 'local' }
    expect(buildInvocation(conn, ARGS, { dockerBinary: '/usr/local/bin/docker' }).file).toBe(
      '/usr/local/bin/docker'
    )
  })

  it('targets a tcp daemon without TLS (no DOCKER_TLS_VERIFY)', () => {
    const conn: DockerConnection = { id: 'c1', label: 'CI', kind: 'tcp', tcp: { host: '10.0.0.5', port: 2375 } }
    expect(buildInvocation(conn, ARGS)).toEqual({
      file: 'docker',
      args: ['-H', 'tcp://10.0.0.5:2375', ...ARGS],
      env: {}
    })
  })

  it('builds ssh DOCKER_HOST with only a host (empty user and port)', () => {
    const conn: DockerConnection = { id: 'c2', label: 'Box', kind: 'ssh', sshTargetId: 't1' }
    const result = buildInvocation(conn, ARGS, { sshTarget: { host: 'host.example', port: 0, username: '' } })
    expect(result.env).toEqual({ DOCKER_HOST: 'ssh://host.example' })
  })

  it('throws when a tcp connection has no tcp config', () => {
    const conn: DockerConnection = { id: 'c1', label: 'CI', kind: 'tcp' }
    expect(() => buildInvocation(conn, ARGS)).toThrow(/tcp config/)
  })

  it('throws when an ssh connection is missing its sshTarget', () => {
    const conn: DockerConnection = { id: 'c2', label: 'Box', kind: 'ssh', sshTargetId: 't1' }
    expect(() => buildInvocation(conn, ARGS)).toThrow(/sshTarget/)
  })
})

describe('defaultDockerBinary', () => {
  it('returns docker.exe on win32 and docker elsewhere', () => {
    expect(defaultDockerBinary('win32')).toBe('docker.exe')
    expect(defaultDockerBinary('darwin')).toBe('docker')
    expect(defaultDockerBinary('linux')).toBe('docker')
  })
})

const PS_OUTPUT = JSON.stringify({
  ID: 'abc123',
  Names: 'web',
  Image: 'nginx',
  State: 'running',
  Status: 'Up 1 minute',
  Labels: ''
})

describe('listContainers', () => {
  it('runs `docker ps -a` and returns parsed summaries', async () => {
    const calls: Array<{ file: string; args: string[] }> = []
    const exec = async (file: string, args: string[], _options?: unknown) => {
      calls.push({ file, args })
      return { stdout: PS_OUTPUT, stderr: '', code: 0 }
    }
    const result = await listContainers({ id: 'local', label: 'Local', kind: 'local' }, { exec })
    expect(calls[0]).toEqual({ file: 'docker', args: ['ps', '-a', '--format', '{{json .}}'] })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'abc123', state: 'running' })
  })

  it('throws DockerCommandError carrying the stderr message and exit code', async () => {
    const exec = async () => ({ stdout: '', stderr: 'Cannot connect to the Docker daemon', code: 1 })
    const error = await listContainers({ id: 'local', label: 'Local', kind: 'local' }, { exec }).catch(
      (e) => e
    )
    expect(error).toBeInstanceOf(DockerCommandError)
    expect(error.message).toContain('Cannot connect to the Docker daemon')
    expect(error.code).toBe(1)
  })
})

const INSPECT_OUTPUT = JSON.stringify([
  { Id: 'abc', Created: '2026-01-01T00:00:00Z', Config: { Env: [] }, HostConfig: { RestartPolicy: { Name: 'no' } } }
])

describe('inspectContainer', () => {
  it('runs `docker inspect <id>` and returns the parsed inspect', async () => {
    const calls: Array<{ file: string; args: string[] }> = []
    const exec = async (file: string, args: string[]) => {
      calls.push({ file, args })
      return { stdout: INSPECT_OUTPUT, stderr: '', code: 0 }
    }
    const result = await inspectContainer({ id: 'local', label: 'Local', kind: 'local' }, 'abc', { exec })
    expect(calls[0]).toEqual({ file: 'docker', args: ['inspect', 'abc'] })
    expect(result).toMatchObject({ id: 'abc', restartPolicy: 'no' })
  })

  it('throws DockerCommandError on a non-zero exit', async () => {
    const exec = async () => ({ stdout: '', stderr: 'No such object: abc', code: 1 })
    await expect(
      inspectContainer({ id: 'local', label: 'Local', kind: 'local' }, 'abc', { exec })
    ).rejects.toThrow(DockerCommandError)
  })

  it('throws DockerCommandError when output cannot be parsed', async () => {
    const exec = async () => ({ stdout: '[]', stderr: '', code: 0 })
    await expect(
      inspectContainer({ id: 'local', label: 'Local', kind: 'local' }, 'abc', { exec })
    ).rejects.toThrow(DockerCommandError)
  })
})
