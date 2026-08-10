import { describe, expect, it, vi } from 'vitest'
import {
  indexDockerContainersByHostPort,
  parseDockerPsOutput,
  parseDockerPublishedPorts,
  scanDockerContainerServices
} from './docker-compose-services'

const SEP = '\u0001'

function row(fields: string[]): string {
  return fields.join(SEP)
}

// Captured verbatim from `docker ps` on a machine running six compose stacks.
const REAL_DOCKER_PS_OUTPUT = [
  row([
    '94f933c4fcea0f6d8468284543f43a86404a758e652e4eef4f0929b390af0313',
    'market-store-postgres-1',
    'postgres:16-alpine',
    '0.0.0.0:5432->5432/tcp',
    'market-store',
    '/Users/me/Work/numis/mono-numis-store/apps/market',
    'running'
  ]),
  row([
    '8f576b0ee6d34cfd8d98eba693dcd842297be33163dd4b2f71c2296cc5faa9f3',
    'numis-funding-postgres-1',
    'postgres:16-alpine',
    '0.0.0.0:5433->5432/tcp',
    'numis-funding',
    '/Users/me/orca/workspaces/mono-numis-store/fra-306-taler-bank-client/apps/numis-funding',
    'running'
  ]),
  row([
    'b4f091836a43e4798180b662ef3cbb31c3a2216b509c70a2a9d69b5784639857',
    'sftp_test-sftp-1',
    'atmoz/sftp',
    '0.0.0.0:2222->22/tcp',
    'sftp_test',
    '/Users/me/Work/booksell/repo/ig-orders/sftp_test',
    'running'
  ])
].join('\n')

describe('parseDockerPublishedPorts', () => {
  it('collapses the IPv4 and IPv6 mapping of one published port', () => {
    expect(parseDockerPublishedPorts('0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp')).toEqual([5432])
  })

  it('reads the host port, not the container port', () => {
    expect(parseDockerPublishedPorts('0.0.0.0:55321->5432/tcp')).toEqual([55321])
  })

  it('keeps every distinct published port of a multi-port container', () => {
    expect(parseDockerPublishedPorts('0.0.0.0:8080->80/tcp, 0.0.0.0:8443->443/tcp')).toEqual([
      8080, 8443
    ])
  })

  it('expands a published port range instead of keeping only its first port', () => {
    expect(parseDockerPublishedPorts('0.0.0.0:8000-8002->8000-8002/tcp')).toEqual([
      8000, 8001, 8002
    ])
  })

  it('keeps a range and a single mapping together', () => {
    expect(
      parseDockerPublishedPorts('0.0.0.0:8000-8001->8000-8001/tcp, 0.0.0.0:9000->9000/tcp')
    ).toEqual([8000, 8001, 9000])
  })

  it('rejects a range whose end is out of bounds', () => {
    expect(parseDockerPublishedPorts('0.0.0.0:65534-70000->1-2/tcp')).toEqual([])
  })

  it('skips UDP mappings because the port scan only reports TCP listeners', () => {
    expect(parseDockerPublishedPorts('0.0.0.0:5353->5353/udp')).toEqual([])
  })

  it('skips exposed-but-unpublished ports', () => {
    expect(parseDockerPublishedPorts('5432/tcp')).toEqual([])
  })

  it('returns nothing for a container with no port column', () => {
    expect(parseDockerPublishedPorts('')).toEqual([])
  })
})

describe('parseDockerPsOutput', () => {
  it('extracts compose project and working dir from real docker output', () => {
    const containers = parseDockerPsOutput(REAL_DOCKER_PS_OUTPUT)

    expect(containers).toHaveLength(3)
    expect(containers[0]).toEqual({
      containerId: '94f933c4fcea',
      containerName: 'market-store-postgres-1',
      image: 'postgres:16-alpine',
      composeProject: 'market-store',
      composeWorkingDir: '/Users/me/Work/numis/mono-numis-store/apps/market',
      hostPorts: [5432],
      state: 'running'
    })
  })

  it('truncates the container id to the short form', () => {
    const [container] = parseDockerPsOutput(REAL_DOCKER_PS_OUTPUT)
    expect(container.containerId).toHaveLength(12)
  })

  it('drops containers with no published port', () => {
    const output = row([
      'abc',
      'internal-only',
      'redis:7',
      '6379/tcp',
      'proj',
      '/tmp/proj',
      'running'
    ])
    expect(parseDockerPsOutput(output)).toEqual([])
  })

  it('reports a non-compose container as having no project rather than guessing', () => {
    const output = row([
      'abc123def456789',
      'standalone-redis',
      'redis:7',
      '0.0.0.0:6379->6379/tcp',
      '<no value>',
      '<no value>',
      'running'
    ])
    const [container] = parseDockerPsOutput(output)

    expect(container.composeProject).toBeNull()
    expect(container.composeWorkingDir).toBeNull()
  })

  it('preserves names containing a tab, which the control-character separator allows', () => {
    const output = row([
      'abc123def4567',
      'weird\tname',
      'img',
      '0.0.0.0:80->80/tcp',
      'proj',
      '/tmp/proj',
      'running'
    ])
    expect(parseDockerPsOutput(output)[0].containerName).toBe('weird\tname')
  })

  it('ignores blank and malformed lines', () => {
    expect(parseDockerPsOutput('\n\nnot-a-row\n')).toEqual([])
  })
})

describe('indexDockerContainersByHostPort', () => {
  it('maps every published port back to its container', () => {
    const byPort = indexDockerContainersByHostPort(parseDockerPsOutput(REAL_DOCKER_PS_OUTPUT))

    expect(byPort.get(5432)?.composeProject).toBe('market-store')
    expect(byPort.get(5433)?.composeProject).toBe('numis-funding')
    expect(byPort.get(2222)?.containerName).toBe('sftp_test-sftp-1')
    expect(byPort.has(9999)).toBe(false)
  })
})

describe('scanDockerContainerServices', () => {
  it('returns the parsed containers when docker responds', async () => {
    const runCommand = vi.fn().mockResolvedValue({ stdout: REAL_DOCKER_PS_OUTPUT })

    const scan = await scanDockerContainerServices(runCommand)

    expect(scan.available).toBe(true)
    expect(scan.containers).toHaveLength(3)
    expect(scan.unavailableReason).toBeUndefined()
  })

  it('leaves the command budget to the scan worker', async () => {
    const runCommand = vi.fn().mockResolvedValue({ stdout: '' })

    await scanDockerContainerServices(runCommand)

    // A timeout argument here would be silently ignored by the worker client,
    // so passing one would misreport the real bound to every reader.
    expect(runCommand.mock.calls[0]).toHaveLength(2)
  })

  it('reports docker as available with no containers, not as unavailable', async () => {
    const runCommand = vi.fn().mockResolvedValue({ stdout: '' })

    const scan = await scanDockerContainerServices(runCommand)

    expect(scan.available).toBe(true)
    expect(scan.containers).toEqual([])
  })

  it('degrades to unavailable when docker is not installed', async () => {
    const runCommand = vi.fn().mockRejectedValue(new Error('spawn docker ENOENT'))

    const scan = await scanDockerContainerServices(runCommand)

    expect(scan).toEqual({
      available: false,
      containers: [],
      unavailableReason: 'Docker is not installed.'
    })
  })

  it('degrades to unavailable when the daemon is stopped', async () => {
    const runCommand = vi
      .fn()
      .mockRejectedValue(
        new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock')
      )

    const scan = await scanDockerContainerServices(runCommand)

    expect(scan.available).toBe(false)
    expect(scan.unavailableReason).toBe('Docker is not running.')
  })

  it('degrades to unavailable when docker times out', async () => {
    const runCommand = vi.fn().mockRejectedValue(new Error('docker timed out after 3000ms'))

    const scan = await scanDockerContainerServices(runCommand)

    expect(scan.available).toBe(false)
    expect(scan.unavailableReason).toBe('Docker did not respond.')
  })

  it('never rejects, so the panel still renders local processes', async () => {
    const runCommand = vi.fn().mockRejectedValue('not even an Error')

    await expect(scanDockerContainerServices(runCommand)).resolves.toMatchObject({
      available: false
    })
  })
})
