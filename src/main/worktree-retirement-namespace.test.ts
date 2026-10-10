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

    // The oldest key retires a second name, then a brand new namespace forces one eviction.
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
    // A second target can still resolve to `old|22|dev`. Stripping its tombstones would reissue a
    // path whose agent history is still on disk — the one outcome retirement exists to prevent.
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
    // Re-import runs this on every add; a no-op copy must not schedule a save.
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
    // Reporting "no change" must mean it left both buckets intact, not that it emptied them.
    expect(Object.keys(namespaces).toSorted()).toEqual([
      'ssh:new|22|dev:posix:/srv/a',
      'ssh:old|22|dev:posix:/srv/a'
    ])
    expect(namespaces['ssh:old|22|dev:posix:/srv/a'].names).toEqual(['nautilus'])
    expect(namespaces['ssh:new|22|dev:posix:/srv/a'].names).toEqual(['nautilus'])
  })

  it('still copies a name the destination folded into its watermark', () => {
    // A destination stored uncompacted trades a folded name for the incoming one, so comparing
    // sizes alone would read as unchanged and drop the copy.
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
    // The cap must not turn a copy back into a move: the source buckets are older than the
    // destinations just appended, so a naive oldest-first trim would delete exactly what the copy
    // was retaining for a live sibling target.
    // The source buckets are the OLDEST entries, so an oldest-first trim would take them first —
    // which is precisely the copy collapsing back into a move.
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
    // Both halves of the copy survive; the two oldest bystanders are what give way.
    expect(namespaces['ssh:old|22|dev:posix:/srv/a']).toBeDefined()
    expect(namespaces['ssh:old|22|dev:posix:/srv/b']).toBeDefined()
    expect(namespaces['ssh:new|22|dev:posix:/srv/a']).toBeDefined()
    expect(namespaces['ssh:new|22|dev:posix:/srv/b']).toBeDefined()
    expect(namespaces['local:posix:/w/0']).toBeUndefined()
    expect(namespaces['local:posix:/w/1']).toBeUndefined()
    expect(namespaces['local:posix:/w/2']).toBeDefined()
  })

  it('refreshes a retained source even when its own merge added nothing', () => {
    // Mixed migration: /srv/a is a no-op because the destination already covers it, /srv/b writes and
    // grows the map. The no-op source is still the bucket a live sibling on the old endpoint reads,
    // so the trim must take a stale bystander instead of it.
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
    // The merge is a no-op, but deleting the source leaves this destination holding the sole copy —
    // so it has been used and must not stay at the front of the eviction queue.
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
    // Protecting the destination only inside the migration's own trim is not enough: the key keeps
    // its original slot, so the next unrelated retirement write evicts it as "oldest" and undoes
    // the migration along with the name the destination already held.
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
    // Assigning to an existing key leaves it in its original slot, so the merged destination is the
    // OLDEST entry here and an unguarded oldest-first trim would drop the name it just absorbed.
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
    // `dev` must not swallow `dev2`: the separator is part of the prefix, not an afterthought.
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
