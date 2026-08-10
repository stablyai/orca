import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as DockerComposeServices from './docker-compose-services'
import type * as LocalWorkspacePortScanner from './local-workspace-port-scanner'
import type * as ServiceProcessAncestry from './service-process-ancestry'

const scanWorkspacePortsMock = vi.hoisted(() => vi.fn())
const scanDockerContainerServicesMock = vi.hoisted(() => vi.fn())
const readProcessAncestryTableMock = vi.hoisted(() => vi.fn())

vi.mock('./local-workspace-port-scanner', async (importOriginal) => ({
  ...(await importOriginal<typeof LocalWorkspacePortScanner>()),
  scanWorkspacePorts: scanWorkspacePortsMock
}))
vi.mock('./docker-compose-services', async (importOriginal) => ({
  ...(await importOriginal<typeof DockerComposeServices>()),
  scanDockerContainerServices: scanDockerContainerServicesMock
}))
vi.mock('./service-process-ancestry', async (importOriginal) => ({
  ...(await importOriginal<typeof ServiceProcessAncestry>()),
  readProcessAncestryTable: readProcessAncestryTableMock
}))

const { scanWorkspaceServices } = await import('./workspace-service-scan')
const { clearServiceIdentityCacheForTests } = await import('./service-project-identity')
const { buildProcessAncestryTable } = await import('./service-process-ancestry')

let liveDir: string

function portScan(ports: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { platform: 'darwin', scannedAt: 1, ports, ...extra }
}

function listeningPort(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'localhost:3939:3232',
    bindHost: '*',
    connectHost: 'localhost',
    port: 3939,
    pid: 3232,
    processName: 'next-server',
    protocol: 'http',
    kind: 'external',
    ...overrides
  }
}

beforeEach(async () => {
  clearServiceIdentityCacheForTests()
  liveDir = await mkdtemp(path.join(tmpdir(), 'orca-service-scan-'))
  scanWorkspacePortsMock.mockResolvedValue(portScan([]))
  scanDockerContainerServicesMock.mockResolvedValue({ available: true, containers: [] })
  readProcessAncestryTableMock.mockResolvedValue(new Map())
})

afterEach(async () => {
  vi.clearAllMocks()
  await rm(liveDir, { recursive: true, force: true })
})

describe('scanWorkspaceServices', () => {
  it('reports the launch command and agent for a listening process', async () => {
    scanWorkspacePortsMock.mockResolvedValue(portScan([listeningPort({ cwd: liveDir })]))
    readProcessAncestryTableMock.mockResolvedValue(
      buildProcessAncestryTable([
        { pid: 3232, ppid: 3037, command: 'next-server (v16.2.9)' },
        { pid: 3037, ppid: 3034, command: 'node /nvm/bin/pnpm dev' },
        { pid: 3034, ppid: 900, command: '/bin/zsh -c source snapshot.sh' },
        { pid: 900, ppid: 1, command: 'claude --teammate-mode auto' }
      ])
    )

    const [service] = (await scanWorkspaceServices([])).services

    expect(service.launchCommand).toBe('pnpm dev')
    expect(service.launchedByAgent).toBe('Claude Code')
    expect(service.kind).toBe('process')
  })

  it('joins a container to its port and takes the project from the compose label', async () => {
    scanWorkspacePortsMock.mockResolvedValue(portScan([listeningPort({ port: 5432 })]))
    scanDockerContainerServicesMock.mockResolvedValue({
      available: true,
      containers: [
        {
          containerId: '94f933c4fcea',
          containerName: 'market-store-postgres-1',
          image: 'postgres:16-alpine',
          composeProject: 'market-store',
          composeWorkingDir: null,
          hostPorts: [5432],
          state: 'running'
        }
      ]
    })

    const [service] = (await scanWorkspaceServices([])).services

    expect(service.kind).toBe('container')
    expect(service.serviceName).toBe('postgres:16-alpine')
    expect(service.projectName).toBe('market-store')
    expect(service.container?.containerName).toBe('market-store-postgres-1')
  })

  it('flags a container whose working directory was deleted as an orphan', async () => {
    scanDockerContainerServicesMock.mockResolvedValue({
      available: true,
      containers: [
        {
          containerId: 'abc123def456',
          containerName: 'numis-funding-postgres-1',
          image: 'postgres:16-alpine',
          composeProject: 'numis-funding',
          composeWorkingDir: path.join(liveDir, 'deleted-worktree'),
          hostPorts: [5433],
          state: 'running'
        }
      ]
    })

    const [service] = (await scanWorkspaceServices([])).services

    expect(service.isOrphan).toBe(true)
    // The compose label still names the project even though the path is gone.
    expect(service.projectName).toBe('numis-funding')
  })

  it('does not flag a service whose working directory still exists', async () => {
    scanWorkspacePortsMock.mockResolvedValue(portScan([listeningPort({ cwd: liveDir })]))

    expect((await scanWorkspaceServices([])).services[0].isOrphan).toBe(false)
  })

  it('does not flag a service that never reported a working directory', async () => {
    scanWorkspacePortsMock.mockResolvedValue(portScan([listeningPort()]))

    expect((await scanWorkspaceServices([])).services[0].isOrphan).toBe(false)
  })

  it('keeps a container whose host port has no local listener', async () => {
    scanDockerContainerServicesMock.mockResolvedValue({
      available: true,
      containers: [
        {
          containerId: 'aaa111bbb222',
          containerName: 'lonely-redis',
          image: 'redis:7',
          composeProject: 'side-project',
          composeWorkingDir: null,
          hostPorts: [6379],
          state: 'running'
        }
      ]
    })

    const services = (await scanWorkspaceServices([])).services

    expect(services).toHaveLength(1)
    expect(services[0].port).toBe(6379)
  })

  it('still returns local processes when docker is unavailable', async () => {
    scanWorkspacePortsMock.mockResolvedValue(portScan([listeningPort()]))
    scanDockerContainerServicesMock.mockResolvedValue({
      available: false,
      containers: [],
      unavailableReason: 'Docker is not running.'
    })

    const result = await scanWorkspaceServices([])

    expect(result.services).toHaveLength(1)
    expect(result.dockerAvailable).toBe(false)
    expect(result.dockerUnavailableReason).toBe('Docker is not running.')
  })

  it('propagates an unavailable port scan without inventing services', async () => {
    scanWorkspacePortsMock.mockResolvedValue(
      portScan([], { unavailableReason: 'Port scanning is unavailable on win32.' })
    )

    const result = await scanWorkspaceServices([])

    expect(result.services).toEqual([])
    expect(result.unavailableReason).toBe('Port scanning is unavailable on win32.')
  })

  it('leaves project and service null when nothing resolves them', async () => {
    scanWorkspacePortsMock.mockResolvedValue(portScan([listeningPort({ cwd: '/' })]))

    const [service] = (await scanWorkspaceServices([])).services

    expect(service.projectName).toBeNull()
    expect(service.serviceName).toBeNull()
  })

  it('attributes a container to the worktree its compose file lives in', async () => {
    // The directory must exist: otherwise the service is also flagged as an
    // orphan and the test passes for the wrong reason.
    const composeDir = path.join(liveDir, 'apps/api')
    await mkdir(composeDir, { recursive: true })
    scanDockerContainerServicesMock.mockResolvedValue({
      available: true,
      containers: [
        {
          containerId: 'ccc333ddd444',
          containerName: 'app-db-1',
          image: 'postgres:16',
          composeProject: 'app',
          composeWorkingDir: composeDir,
          hostPorts: [5544],
          state: 'running'
        }
      ]
    })

    const [service] = (
      await scanWorkspaceServices([
        { id: 'wt-1', repoId: 'repo-1', displayName: 'feature-branch', path: liveDir }
      ])
    ).services

    expect(service.owner?.worktreeId).toBe('wt-1')
    expect(service.isOrphan).toBe(false)
  })

  it('sorts processes before containers, then by port', async () => {
    scanWorkspacePortsMock.mockResolvedValue(
      portScan([listeningPort({ id: 'b', port: 9000 }), listeningPort({ id: 'a', port: 3000 })])
    )
    scanDockerContainerServicesMock.mockResolvedValue({
      available: true,
      containers: [
        {
          containerId: 'eee555fff666',
          containerName: 'db',
          image: 'postgres:16',
          composeProject: null,
          composeWorkingDir: null,
          hostPorts: [5432],
          state: 'running'
        }
      ]
    })

    const services = (await scanWorkspaceServices([])).services

    expect(services.map((service) => service.port)).toEqual([3000, 9000, 5432])
  })
})
