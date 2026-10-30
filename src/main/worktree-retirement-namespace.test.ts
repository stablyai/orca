import { describe, expect, it } from 'vitest'
import type { RetiredNameRegistry } from '../shared/worktree/retired-name-registry'
import {
  MAX_RETIREMENT_NAMESPACES,
  migrateRetirementNamespaceHostIdentity,
  recordRetirementNamespaceRegistry,
  retirementHostIdentity,
  retirementNamespaceKey,
  UNKNOWN_SSH_HOST_IDENTITY
} from './worktree-retirement-namespace'

function registry(...names: string[]): RetiredNameRegistry {
  return { exhaustedTiers: 0, names }
}

const TARGET = {
  configHost: 'builder',
  host: 'builder.example.com',
  port: 22,
  username: 'dev'
}

describe('recordRetirementNamespaceRegistry', () => {
  it('evicts the least recently recorded namespace once the map is full', () => {
    const namespaces: Record<string, RetiredNameRegistry> = {}
    for (let index = 0; index < MAX_RETIREMENT_NAMESPACES; index += 1) {
      recordRetirementNamespaceRegistry(namespaces, `local:posix:/w/${index}`, registry('nautilus'))
    }

    recordRetirementNamespaceRegistry(namespaces, 'local:posix:/w/new', registry('seahorse'))

    expect(Object.keys(namespaces)).toHaveLength(MAX_RETIREMENT_NAMESPACES)
    expect(namespaces['local:posix:/w/0']).toBeUndefined()
    expect(namespaces['local:posix:/w/1']).toEqual(registry('nautilus'))
    expect(namespaces['local:posix:/w/new']).toEqual(registry('seahorse'))
  })

  it('refreshes a namespace it rewrites so an actively used repo is never the eviction victim', () => {
    const namespaces: Record<string, RetiredNameRegistry> = {}
    for (let index = 0; index < MAX_RETIREMENT_NAMESPACES; index += 1) {
      recordRetirementNamespaceRegistry(namespaces, `local:posix:/w/${index}`, registry('nautilus'))
    }

    recordRetirementNamespaceRegistry(namespaces, 'local:posix:/w/0', registry('nautilus', 'orca'))
    recordRetirementNamespaceRegistry(namespaces, 'local:posix:/w/new', registry('seahorse'))

    expect(namespaces['local:posix:/w/0']).toEqual(registry('nautilus', 'orca'))
    expect(namespaces['local:posix:/w/1']).toBeUndefined()
  })

  it('stays at one entry per namespace no matter how often it is rewritten', () => {
    const namespaces: Record<string, RetiredNameRegistry> = {}
    for (let index = 0; index < MAX_RETIREMENT_NAMESPACES * 2; index += 1) {
      recordRetirementNamespaceRegistry(namespaces, 'local:posix:/w/a', registry(`name-${index}`))
    }

    expect(Object.keys(namespaces)).toEqual(['local:posix:/w/a'])
  })
})

describe('migrateRetirementNamespaceHostIdentity', () => {
  it('folds a migrated namespace into one the new identity already owns', () => {
    const namespaces = {
      'ssh:old-id:posix:/srv/a': registry('nautilus'),
      'ssh:new|22|dev:posix:/srv/a': registry('seahorse')
    }

    expect(
      migrateRetirementNamespaceHostIdentity(namespaces, {
        moveFrom: ['ssh:old-id'],
        to: 'ssh:new|22|dev'
      })
    ).toBe(true)
    expect(Object.keys(namespaces)).toEqual(['ssh:new|22|dev:posix:/srv/a'])
    expect(namespaces['ssh:new|22|dev:posix:/srv/a'].names.toSorted()).toEqual([
      'nautilus',
      'seahorse'
    ])
  })

  it('keeps the source bucket when an endpoint identity moves, since a live target may share it', () => {
    const namespaces = {
      'ssh:old|22|dev:posix:/srv/a': registry('nautilus')
    }

    expect(
      migrateRetirementNamespaceHostIdentity(namespaces, {
        copyFrom: ['ssh:old|22|dev'],
        to: 'ssh:new|22|dev'
      })
    ).toBe(true)
    expect(Object.keys(namespaces).toSorted()).toEqual([
      'ssh:new|22|dev:posix:/srv/a',
      'ssh:old|22|dev:posix:/srv/a'
    ])
    expect(namespaces['ssh:old|22|dev:posix:/srv/a'].names).toEqual(['nautilus'])
    expect(namespaces['ssh:new|22|dev:posix:/srv/a'].names).toEqual(['nautilus'])
  })

  it('reports no change when a repeated copy adds nothing the destination lacks', () => {
    const namespaces = {
      'ssh:old|22|dev:posix:/srv/a': registry('nautilus'),
      'ssh:new|22|dev:posix:/srv/a': registry('nautilus')
    }

    expect(
      migrateRetirementNamespaceHostIdentity(namespaces, {
        copyFrom: ['ssh:old|22|dev'],
        to: 'ssh:new|22|dev'
      })
    ).toBe(false)
    expect(Object.keys(namespaces).toSorted()).toEqual([
      'ssh:new|22|dev:posix:/srv/a',
      'ssh:old|22|dev:posix:/srv/a'
    ])
    expect(namespaces['ssh:old|22|dev:posix:/srv/a'].names).toEqual(['nautilus'])
    expect(namespaces['ssh:new|22|dev:posix:/srv/a'].names).toEqual(['nautilus'])
  })

  it('still copies a name the destination folded into its watermark', () => {
    // Equal sizes can hide a new name when an old one folds into the watermark.
    const namespaces = {
      'ssh:old|22|dev:posix:/srv/a': registry('seahorse-2'),
      'ssh:new|22|dev:posix:/srv/a': { exhaustedTiers: 1, names: ['nautilus'] }
    }

    expect(
      migrateRetirementNamespaceHostIdentity(namespaces, {
        copyFrom: ['ssh:old|22|dev'],
        to: 'ssh:new|22|dev'
      })
    ).toBe(true)
    expect(namespaces['ssh:new|22|dev:posix:/srv/a'].names).toContain('seahorse-2')
  })

  it('keeps the namespace map within its cap by evicting bystanders, not the copy itself', () => {
    // Old source buckets must survive trimming too, or copying would effectively move their tombstones.
    const namespaces: Record<string, RetiredNameRegistry> = {
      'ssh:old|22|dev:posix:/srv/a': registry('nautilus'),
      'ssh:old|22|dev:posix:/srv/b': registry('manta')
    }
    for (let index = 0; index < MAX_RETIREMENT_NAMESPACES - 2; index += 1) {
      namespaces[`local:posix:/w/${index}`] = registry('dolphin')
    }

    expect(
      migrateRetirementNamespaceHostIdentity(namespaces, {
        copyFrom: ['ssh:old|22|dev'],
        to: 'ssh:new|22|dev'
      })
    ).toBe(true)
    expect(Object.keys(namespaces).length).toBe(MAX_RETIREMENT_NAMESPACES)
    expect(namespaces['ssh:old|22|dev:posix:/srv/a']).toBeDefined()
    expect(namespaces['ssh:old|22|dev:posix:/srv/b']).toBeDefined()
    expect(namespaces['ssh:new|22|dev:posix:/srv/a']).toBeDefined()
    expect(namespaces['ssh:new|22|dev:posix:/srv/b']).toBeDefined()
    expect(namespaces['local:posix:/w/0']).toBeUndefined()
    expect(namespaces['local:posix:/w/1']).toBeUndefined()
    expect(namespaces['local:posix:/w/2']).toBeDefined()
  })

  it('refreshes a retained source even when its own merge added nothing', () => {
    // A no-op source remains live while another copied namespace grows the map.
    const namespaces: Record<string, RetiredNameRegistry> = {
      'ssh:old|22|dev:posix:/srv/a': registry('seahorse'),
      'ssh:new|22|dev:posix:/srv/a': registry('seahorse'),
      'ssh:old|22|dev:posix:/srv/b': registry('nautilus')
    }
    for (let index = 0; index < MAX_RETIREMENT_NAMESPACES - 3; index += 1) {
      namespaces[`local:posix:/w/${index}`] = registry('dolphin')
    }

    migrateRetirementNamespaceHostIdentity(namespaces, {
      copyFrom: ['ssh:old|22|dev'],
      to: 'ssh:new|22|dev'
    })
    expect(Object.keys(namespaces).length).toBe(MAX_RETIREMENT_NAMESPACES)
    expect(namespaces['ssh:old|22|dev:posix:/srv/a']).toBeDefined()
    expect(namespaces['local:posix:/w/0']).toBeUndefined()
  })

  it('refreshes a move destination that the move just made the only copy', () => {
    const namespaces: Record<string, RetiredNameRegistry> = {
      'ssh:new|22|dev:posix:/srv/a': registry('seahorse'),
      'local:posix:/w/0': registry('dolphin'),
      'ssh:old-id:posix:/srv/a': registry('seahorse')
    }

    migrateRetirementNamespaceHostIdentity(namespaces, {
      moveFrom: ['ssh:old-id'],
      to: 'ssh:new|22|dev'
    })
    expect(Object.keys(namespaces).at(-1)).toBe('ssh:new|22|dev:posix:/srv/a')
  })

  it('leaves a merged destination newest, so the very next ordinary write cannot evict it', () => {
    const namespaces: Record<string, RetiredNameRegistry> = {
      'ssh:new|22|dev:posix:/srv/a': registry('seahorse')
    }
    for (let index = 0; index < MAX_RETIREMENT_NAMESPACES - 2; index += 1) {
      namespaces[`local:posix:/w/${index}`] = registry('dolphin')
    }
    namespaces['ssh:old|22|dev:posix:/srv/a'] = registry('nautilus')

    migrateRetirementNamespaceHostIdentity(namespaces, {
      copyFrom: ['ssh:old|22|dev'],
      to: 'ssh:new|22|dev'
    })
    recordRetirementNamespaceRegistry(namespaces, 'local:posix:/fresh', registry('manta'))

    const destination = namespaces['ssh:new|22|dev:posix:/srv/a']
    expect(destination).toBeDefined()
    expect(destination.names.toSorted()).toEqual(['nautilus', 'seahorse'])
  })

  it('does not let the cap evict a destination it just merged into', () => {
    const namespaces: Record<string, RetiredNameRegistry> = {
      'ssh:new|22|dev:posix:/srv/a': registry('seahorse')
    }
    for (let index = 0; index < MAX_RETIREMENT_NAMESPACES - 2; index += 1) {
      namespaces[`local:posix:/w/${index}`] = registry('dolphin')
    }
    namespaces['ssh:old|22|dev:posix:/srv/a'] = registry('nautilus')
    namespaces['ssh:old|22|dev:posix:/srv/b'] = registry('manta')

    expect(
      migrateRetirementNamespaceHostIdentity(namespaces, {
        copyFrom: ['ssh:old|22|dev'],
        to: 'ssh:new|22|dev'
      })
    ).toBe(true)
    const destination = namespaces['ssh:new|22|dev:posix:/srv/a']
    expect(destination).toBeDefined()
    expect(destination.names.toSorted()).toEqual(['nautilus', 'seahorse'])
  })

  it('leaves an identity that merely shares a prefix with the old one alone', () => {
    const namespaces = {
      'ssh:h|22|dev2:posix:/srv/a': registry('nautilus')
    }

    expect(
      migrateRetirementNamespaceHostIdentity(namespaces, {
        moveFrom: ['ssh:h|22|dev'],
        to: 'ssh:h|22|other'
      })
    ).toBe(false)
    expect(Object.keys(namespaces)).toEqual(['ssh:h|22|dev2:posix:/srv/a'])
  })

  it('reports no change when there is nothing to move or the identity is unchanged', () => {
    expect(
      migrateRetirementNamespaceHostIdentity(undefined, { moveFrom: ['ssh:a'], to: 'ssh:b' })
    ).toBe(false)
    expect(
      migrateRetirementNamespaceHostIdentity(
        { 'ssh:a:posix:/srv': registry('nautilus') },
        { to: 'ssh:a' }
      )
    ).toBe(false)
    expect(
      migrateRetirementNamespaceHostIdentity(
        { 'ssh:a:posix:/srv': registry('nautilus') },
        { moveFrom: ['ssh:a'], to: 'ssh:a' }
      )
    ).toBe(false)
  })
})

describe('retirementHostIdentity', () => {
  it('resolves an SSH repo to the endpoint its target reaches, not the target row id', () => {
    const identity = retirementHostIdentity({ connectionId: 'ssh-1' }, () => TARGET)

    expect(identity).toBe('ssh:builder.example.com|22|dev')
    expect(retirementHostIdentity({ connectionId: 'ssh-2' }, () => TARGET)).toBe(identity)
  })

  it('falls back to one shared bucket when the target row is gone', () => {
    expect(retirementHostIdentity({ connectionId: 'ssh-1' }, () => undefined)).toBe(
      UNKNOWN_SSH_HOST_IDENTITY
    )
    expect(retirementHostIdentity({ connectionId: 'ssh-1' })).toBe(UNKNOWN_SSH_HOST_IDENTITY)
  })

  it('leaves a non-SSH repo on its execution host id', () => {
    expect(retirementHostIdentity({})).toBe('local')
  })
})

describe('retirementNamespaceKey', () => {
  it('keeps Windows paths case- and separator-insensitive without colliding with a POSIX path', () => {
    expect(retirementNamespaceKey('local', 'C:\\Workspaces\\Probe')).toBe(
      retirementNamespaceKey('local', 'C:/workspaces/probe')
    )
    expect(retirementNamespaceKey('local', 'C:\\workspaces\\probe')).not.toBe(
      retirementNamespaceKey('local', '/workspaces/probe')
    )
  })

  it('keeps POSIX paths case-sensitive, matching the filesystems they name', () => {
    expect(retirementNamespaceKey('local', '/srv/Probe')).not.toBe(
      retirementNamespaceKey('local', '/srv/probe')
    )
  })
})
