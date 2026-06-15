import { describe, expect, it } from 'vitest'
import type { DockerConnection } from '../../shared/docker-types'
import { buildInvocation, defaultDockerBinary } from './docker-command-runner'

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
