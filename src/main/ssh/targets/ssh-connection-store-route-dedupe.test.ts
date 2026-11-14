import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SshConnectionStore } from './ssh-connection-store'
import { createMockStore } from './testing/ssh-connection-store-test-fixture'
import { parseSshGOutput } from '../config/ssh-g-config-resolution'
import type { SshTarget } from '../../../shared/ssh-types'

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('../config/ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  loadUserSshConfigWithText: () => {
    const hosts = loadUserSshConfigMock()
    return { hosts, text: JSON.stringify(hosts ?? []) }
  },
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))

let mockStore: ReturnType<typeof createMockStore>
let sshStore: SshConnectionStore

beforeEach(() => {
  mockStore = createMockStore()
  loadUserSshConfigMock.mockReset()
  sshConfigHostsToTargetsMock.mockReset()
})

describe('SshConnectionStore import route de-duplication', () => {
  // A fake `ssh -G`: what OpenSSH would resolve for each alias.
  const sshG: Record<string, string> = {
    '172.16.203.131': 'hostname 172.16.203.131\nuser me\nport 22',
    aimp: 'hostname 172.16.203.131\nuser chanmuzi\nport 22',
    'aimp-no-hostname': 'hostname aimp-no-hostname\nuser chanmuzi\nport 22',
    'via-b': 'hostname 172.16.203.131\nuser chanmuzi\nport 22\nproxyjump bastion-b',
    'via-a': 'hostname 172.16.203.131\nuser chanmuzi\nport 22\nproxycommand ssh bastion-a -W %h:%p',
    prod: 'hostname 10.0.0.9\nuser chanmuzi\nport 22',
    moved: 'hostname 10.0.0.77\nuser chanmuzi\nport 22',
    'moved-twin': 'hostname 10.0.0.77\nuser chanmuzi\nport 22',
    'removed-block': 'hostname removed-block\nuser chanmuzi\nport 22',
    fresh: 'hostname removed-block\nuser chanmuzi\nport 22',
    old: 'hostname 10.0.0.1\nuser chanmuzi\nport 22\nproxyjump b',
    'saved-own-jump':
      'hostname 172.16.203.131\nuser chanmuzi\nport 22\nproxycommand ssh bastion-a -W %h:%p'
  }
  const resolveConfig = vi.fn(async (alias: string) =>
    sshG[alias] ? parseSshGOutput(sshG[alias]!) : null
  )
  // OpenSSH given system ssh's args: the saved user, a non-22 port and its own proxy override the config.
  const unclaimedAliases = new Set<string>()
  const systemRoute = vi.fn(
    async (target: SshTarget, options: { aliasClaimedByConfig?: false }) => {
      const resolved = await resolveConfig(target.configHost || target.host)
      if (!resolved) {
        return null
      }
      if (options.aliasClaimedByConfig === false) {
        // No Host block left: system ssh restores the saved endpoint.
        return { ...resolved, hostname: target.host, port: target.port, user: target.username }
      }
      const ownProxy = target.jumpHost
        ? { proxyJump: target.jumpHost, proxyCommand: undefined }
        : target.proxyCommand
          ? { proxyCommand: target.proxyCommand, proxyJump: undefined }
          : {}
      return {
        ...resolved,
        ...(target.username ? { user: target.username } : {}),
        ...(target.port !== 22 ? { port: target.port } : {}),
        ...ownProxy
      }
    }
  )
  const manualByIp: SshTarget = {
    id: 'ssh-manual',
    label: 'AI Box',
    configHost: '172.16.203.131',
    host: '172.16.203.131',
    port: 22,
    username: 'chanmuzi',
    source: 'manual'
  }
  const configCandidate = (alias: string): SshTarget => ({
    id: `tmp-${alias}`,
    label: alias,
    configHost: alias,
    host: alias,
    port: 22,
    username: ''
  })

  beforeEach(() => {
    resolveConfig.mockClear()
    systemRoute.mockClear()
    unclaimedAliases.clear()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements the Store methods SshConnectionStore calls.
    sshStore = new SshConnectionStore(mockStore as never, {
      config: resolveConfig,
      systemRoute,
      aliasClaimed: (alias) => !unclaimedAliases.has(alias)
    })
    mockStore.addSshTarget(manualByIp)
    mockStore.addSshTarget.mockClear()
    loadUserSshConfigMock.mockReturnValue([])
  })

  it('keeps a route match when this import itself updates the matched target', async () => {
    mockStore.addSshTarget({
      ...configCandidate('moved'),
      id: 'ssh-moved',
      host: '10.0.0.1',
      source: 'ssh-config'
    })
    sshConfigHostsToTargetsMock.mockReturnValue([
      { ...configCandidate('moved'), host: '10.0.0.77' },
      configCandidate('moved-twin')
    ])

    const { targets } = await sshStore.importFromSshConfig()

    expect(targets.map((target) => target.id)).toEqual(['ssh-moved'])
  })

  it('skips the duplicate when two imports overlap and the other one updated the matched target', async () => {
    mockStore.addSshTarget({
      ...configCandidate('moved'),
      id: 'ssh-moved',
      host: '10.0.0.1',
      source: 'ssh-config'
    })
    sshConfigHostsToTargetsMock.mockReturnValue([
      { ...configCandidate('moved'), host: '10.0.0.77' },
      configCandidate('moved-twin')
    ])

    const [first, second] = await Promise.all([
      sshStore.importFromSshConfig(),
      sshStore.importFromSshConfig()
    ])

    expect([...first.targets, ...second.targets].map((target) => target.id)).toEqual(['ssh-moved'])
  })

  it('rebuilds the snapshot after an import changes targets, so the picker keeps the skipped alias flagged', async () => {
    sshConfigHostsToTargetsMock.mockReturnValue([configCandidate('aimp'), configCandidate('via-b')])

    expect((await sshStore.importFromSshConfig()).targets).toHaveLength(1)

    await vi.waitFor(() =>
      expect(sshStore.currentSshRouteSnapshot()?.duplicateOf.has('aimp')).toBe(true)
    )
  })

  it('lets Restore bring back a removed alias that shares a saved route, as its dialog promised', async () => {
    sshConfigHostsToTargetsMock.mockReturnValue([configCandidate('aimp')])
    mockStore.addDeletedSshConfigAlias('aimp')

    expect((await sshStore.importFromSshConfig()).targets).toEqual([])
    expect((await sshStore.importFromSshConfig({ reAdopt: true })).targets).toHaveLength(1)
  })
})
