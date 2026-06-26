import { describe, expect, it, vi } from 'vitest'
import { listDevcontainers, parseDevcontainer } from './discovery'
import type { DockerClient, DockerInspect, DockerPsEntry } from './docker-client'

function inspectFixture(overrides: Partial<DockerInspect> = {}): DockerInspect {
  return {
    Id: 'abc123',
    Name: '/cranky_swartz',
    Config: {
      Labels: {
        'devcontainer.local_folder': '/Users/me/work/aprium',
        'devcontainer.config_file': '/Users/me/work/aprium/.devcontainer/devcontainer.json'
      }
    },
    Mounts: [
      { Type: 'bind', Source: '/Users/me/work/aprium', Destination: '/workspaces/aprium' },
      { Type: 'volume', Source: '/var/lib/docker/volumes/x/_data', Destination: '/cache' }
    ],
    State: { Running: true },
    ...overrides
  }
}

describe('parseDevcontainer', () => {
  it('extracts id, name, host folder, config file, and mounts', () => {
    expect(parseDevcontainer(inspectFixture())).toEqual({
      containerId: 'abc123',
      name: 'cranky_swartz',
      hostFolder: '/Users/me/work/aprium',
      configFile: '/Users/me/work/aprium/.devcontainer/devcontainer.json',
      running: true,
      mounts: [
        { source: '/Users/me/work/aprium', destination: '/workspaces/aprium' },
        { source: '/var/lib/docker/volumes/x/_data', destination: '/cache' }
      ]
    })
  })

  it('returns null when the devcontainer label is absent', () => {
    expect(parseDevcontainer(inspectFixture({ Config: { Labels: { foo: 'bar' } } }))).toBeNull()
    expect(parseDevcontainer(inspectFixture({ Config: { Labels: null } }))).toBeNull()
    expect(parseDevcontainer(inspectFixture({ Config: undefined }))).toBeNull()
  })

  it('defaults configFile to null and tolerates missing/partial mounts', () => {
    const info = parseDevcontainer(
      inspectFixture({
        Config: { Labels: { 'devcontainer.local_folder': '/Users/me/work/lac' } },
        Mounts: [
          { Type: 'bind', Source: '/Users/me/work/lac', Destination: '/workspaces/lac' },
          { Type: 'bind', Source: '', Destination: '/skip' },
          { Type: 'tmpfs', Destination: '/tmp' }
        ]
      })
    )
    expect(info?.configFile).toBeNull()
    expect(info?.mounts).toEqual([{ source: '/Users/me/work/lac', destination: '/workspaces/lac' }])
  })
})

describe('listDevcontainers', () => {
  function stubClient(overrides: Partial<DockerClient> = {}): DockerClient {
    return {
      listContainersByLabel: vi.fn(async () => [] as DockerPsEntry[]),
      inspectContainer: vi.fn(async () => null),
      startContainer: vi.fn(async () => {}),
      ...overrides
    }
  }

  it('queries by the devcontainer label and returns parsed infos', async () => {
    const listContainersByLabel = vi.fn(async () => [{ ID: 'abc123', Names: 'cranky_swartz' }])
    const inspectContainer = vi.fn(async () => inspectFixture())
    const result = await listDevcontainers(stubClient({ listContainersByLabel, inspectContainer }))

    expect(listContainersByLabel).toHaveBeenCalledWith('devcontainer.local_folder', {})
    expect(inspectContainer).toHaveBeenCalledWith('abc123')
    expect(result).toHaveLength(1)
    expect(result[0]?.hostFolder).toBe('/Users/me/work/aprium')
  })

  it('skips containers that vanished or fail inspection', async () => {
    const inspectContainer = vi
      .fn()
      .mockResolvedValueOnce(null) // removed mid-discovery
      .mockRejectedValueOnce(new Error('inspect failed')) // transient docker error
      .mockResolvedValueOnce(inspectFixture())
    const result = await listDevcontainers(
      stubClient({
        listContainersByLabel: vi.fn(async () => [
          { ID: 'gone', Names: 'gone' },
          { ID: 'broken', Names: 'broken' },
          { ID: 'abc123', Names: 'ok' }
        ]),
        inspectContainer
      })
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.containerId).toBe('abc123')
  })
})
