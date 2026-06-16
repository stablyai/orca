import { describe, expect, it, afterEach } from 'vitest'
import type {
  DockerConnection,
  DockerContainerAction,
  DockerResourceKind
} from '../../shared/docker-types'
import {
  buildInvocation,
  defaultDockerBinary,
  sanitizedBaseEnv,
  listContainers,
  DockerCommandError,
  inspectContainer,
  runContainerAction,
  listImages,
  listVolumes,
  listNetworks,
  runResourceRemove,
  runResourcePrune
} from './docker-command-runner'

const EXPECTED_BINARY = defaultDockerBinary()

const ARGS = ['ps', '-a', '--format', '{{json .}}']

describe('buildInvocation', () => {
  it('runs the local binary directly with no extra env', () => {
    const conn: DockerConnection = { id: 'local', label: 'Local', kind: 'local' }
    expect(buildInvocation(conn, ARGS)).toEqual({ file: EXPECTED_BINARY, args: ARGS, env: {} })
  })

  it('targets a tcp daemon with -H and sets TLS verify when configured', () => {
    const conn: DockerConnection = {
      id: 'c1',
      label: 'CI',
      kind: 'tcp',
      tcp: { host: '10.0.0.5', port: 2376, tls: true }
    }
    expect(buildInvocation(conn, ARGS)).toEqual({
      file: EXPECTED_BINARY,
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
      file: EXPECTED_BINARY,
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
    const conn: DockerConnection = {
      id: 'c1',
      label: 'CI',
      kind: 'tcp',
      tcp: { host: '10.0.0.5', port: 2375 }
    }
    expect(buildInvocation(conn, ARGS)).toEqual({
      file: EXPECTED_BINARY,
      args: ['-H', 'tcp://10.0.0.5:2375', ...ARGS],
      env: {}
    })
  })

  it('builds ssh DOCKER_HOST with only a host (empty user and port)', () => {
    const conn: DockerConnection = { id: 'c2', label: 'Box', kind: 'ssh', sshTargetId: 't1' }
    const result = buildInvocation(conn, ARGS, {
      sshTarget: { host: 'host.example', port: 0, username: '' }
    })
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

describe('sanitizedBaseEnv', () => {
  const DOCKER_KEYS = [
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH'
  ] as const
  const saved: Partial<Record<string, string>> = {}

  afterEach(() => {
    // Restore process.env to its pre-test state.
    for (const key of DOCKER_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = saved[key]
      }
    }
  })

  it('strips all inherited DOCKER_* env keys that could redirect the daemon', () => {
    // Set every key so the test is meaningful regardless of the host environment.
    for (const key of DOCKER_KEYS) {
      saved[key] = process.env[key]
      process.env[key] = `test-value-${key}`
    }
    const result = sanitizedBaseEnv()
    for (const key of DOCKER_KEYS) {
      expect(result).not.toHaveProperty(key)
    }
  })

  it('preserves unrelated env vars', () => {
    const result = sanitizedBaseEnv()
    // PATH should survive (present on every platform that runs these tests).
    expect(result).toHaveProperty('PATH')
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
    const calls: { file: string; args: string[] }[] = []
    const exec = async (file: string, args: string[], _options?: unknown) => {
      calls.push({ file, args })
      return { stdout: PS_OUTPUT, stderr: '', code: 0 }
    }
    const result = await listContainers({ id: 'local', label: 'Local', kind: 'local' }, { exec })
    expect(calls[0]).toEqual({
      file: EXPECTED_BINARY,
      args: ['ps', '-a', '--format', '{{json .}}']
    })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'abc123', state: 'running' })
  })

  it('throws DockerCommandError carrying the stderr message and exit code', async () => {
    const exec = async () => ({
      stdout: '',
      stderr: 'Cannot connect to the Docker daemon',
      code: 1
    })
    const error = await listContainers(
      { id: 'local', label: 'Local', kind: 'local' },
      { exec }
    ).catch((e) => e)
    expect(error).toBeInstanceOf(DockerCommandError)
    expect(error.message).toContain('Cannot connect to the Docker daemon')
    expect(error.code).toBe(1)
  })
})

const INSPECT_OUTPUT = JSON.stringify([
  {
    Id: 'abc',
    Created: '2026-01-01T00:00:00Z',
    Config: { Env: [] },
    HostConfig: { RestartPolicy: { Name: 'no' } }
  }
])

describe('inspectContainer', () => {
  it('runs `docker inspect <id>` and returns the parsed inspect', async () => {
    const calls: { file: string; args: string[] }[] = []
    const exec = async (file: string, args: string[]) => {
      calls.push({ file, args })
      return { stdout: INSPECT_OUTPUT, stderr: '', code: 0 }
    }
    const result = await inspectContainer({ id: 'local', label: 'Local', kind: 'local' }, 'abc', {
      exec
    })
    expect(calls[0]).toEqual({ file: EXPECTED_BINARY, args: ['inspect', 'abc'] })
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

describe('runContainerAction', () => {
  const cases: [DockerContainerAction, string[]][] = [
    ['start', ['start', 'abc']],
    ['stop', ['stop', 'abc']],
    ['restart', ['restart', 'abc']],
    ['pause', ['pause', 'abc']],
    ['unpause', ['unpause', 'abc']],
    ['remove', ['rm', '-f', 'abc']]
  ]
  it.each(cases)('maps %s to the right docker argv', async (action, expectedArgs) => {
    const calls: { file: string; args: string[] }[] = []
    const exec = async (file: string, args: string[]) => {
      calls.push({ file, args })
      return { stdout: '', stderr: '', code: 0 }
    }
    await runContainerAction({ id: 'local', label: 'Local', kind: 'local' }, 'abc', action, {
      exec
    })
    expect(calls[0]).toEqual({ file: EXPECTED_BINARY, args: expectedArgs })
  })

  it('throws DockerCommandError on a non-zero exit', async () => {
    const exec = async () => ({ stdout: '', stderr: 'permission denied', code: 1 })
    await expect(
      runContainerAction({ id: 'local', label: 'Local', kind: 'local' }, 'abc', 'stop', { exec })
    ).rejects.toThrow(DockerCommandError)
  })
})

describe('listImages/listVolumes/listNetworks', () => {
  it('listImages runs `docker images --format` and parses', async () => {
    const calls: { file: string; args: string[] }[] = []
    const exec = async (file: string, args: string[]) => {
      calls.push({ file, args })
      return {
        stdout: JSON.stringify({
          ID: 'i',
          Repository: 'r',
          Tag: 't',
          Size: '1MB',
          CreatedSince: 'now'
        }),
        stderr: '',
        code: 0
      }
    }
    const result = await listImages({ id: 'local', label: 'Local', kind: 'local' }, { exec })
    expect(calls[0]).toEqual({ file: EXPECTED_BINARY, args: ['images', '--format', '{{json .}}'] })
    expect(result[0]).toMatchObject({ id: 'i', repository: 'r' })
  })
  it('listVolumes runs `docker volume ls --format`', async () => {
    const calls: { file: string; args: string[] }[] = []
    const exec = async (file: string, args: string[]) => {
      calls.push({ file, args })
      return { stdout: '', stderr: '', code: 0 }
    }
    await listVolumes({ id: 'local', label: 'Local', kind: 'local' }, { exec })
    expect(calls[0]).toEqual({
      file: EXPECTED_BINARY,
      args: ['volume', 'ls', '--format', '{{json .}}']
    })
  })
  it('listNetworks runs `docker network ls --format`', async () => {
    const calls: { file: string; args: string[] }[] = []
    const exec = async (file: string, args: string[]) => {
      calls.push({ file, args })
      return { stdout: '', stderr: '', code: 0 }
    }
    await listNetworks({ id: 'local', label: 'Local', kind: 'local' }, { exec })
    expect(calls[0]).toEqual({
      file: EXPECTED_BINARY,
      args: ['network', 'ls', '--format', '{{json .}}']
    })
  })
  it('listImages throws DockerCommandError on non-zero exit', async () => {
    const exec = async () => ({ stdout: '', stderr: 'boom', code: 1 })
    await expect(
      listImages({ id: 'local', label: 'Local', kind: 'local' }, { exec })
    ).rejects.toThrow(DockerCommandError)
  })
})

describe('runResourceRemove', () => {
  const cases: [DockerResourceKind, string[]][] = [
    ['container', ['rm', '-f', 'x']],
    ['image', ['rmi', 'x']],
    ['volume', ['volume', 'rm', 'x']],
    ['network', ['network', 'rm', 'x']]
  ]
  it.each(cases)('%s remove → right argv', async (kind, args) => {
    const calls: { args: string[] }[] = []
    const exec = async (_file: string, a: string[]) => {
      calls.push({ args: a })
      return { stdout: '', stderr: '', code: 0 }
    }
    await runResourceRemove({ id: 'local', label: 'Local', kind: 'local' }, kind, 'x', { exec })
    expect(calls[0].args).toEqual(args)
  })
  it('throws on non-zero exit', async () => {
    const exec = async () => ({ stdout: '', stderr: 'in use', code: 1 })
    await expect(
      runResourceRemove({ id: 'local', label: 'Local', kind: 'local' }, 'image', 'x', { exec })
    ).rejects.toThrow(DockerCommandError)
  })
})

describe('runResourcePrune', () => {
  const cases: [DockerResourceKind, string[]][] = [
    ['container', ['container', 'prune', '-f']],
    ['image', ['image', 'prune', '-f']],
    ['volume', ['volume', 'prune', '-f']],
    ['network', ['network', 'prune', '-f']]
  ]
  it.each(cases)('%s prune → right argv', async (kind, args) => {
    const calls: { args: string[] }[] = []
    const exec = async (_file: string, a: string[]) => {
      calls.push({ args: a })
      return { stdout: '', stderr: '', code: 0 }
    }
    await runResourcePrune({ id: 'local', label: 'Local', kind: 'local' }, kind, { exec })
    expect(calls[0].args).toEqual(args)
  })
})
