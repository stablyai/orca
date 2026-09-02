import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import process from 'node:process'
import {
  interpreterOnDiskWarning,
  resolveRealPath,
  socketPathBudgetWarning,
  versionScopedInterpreterWarning
} from './supervisor-generation-warnings'

describe('version-scoped interpreter', () => {
  // One `brew upgrade node` removes the Cellar directory the unit names, and it dies
  // 203/EXEC long after the change that caused it.
  it.each([
    '/home/linuxbrew/.linuxbrew/Cellar/node/25.8.0/bin/node',
    '/opt/homebrew/Cellar/node/22.1.0/bin/node',
    '/home/me/.nvm/versions/node/v22.11.0/bin/node',
    '/home/me/.local/share/mise/installs/node/22.11.0/bin/node',
    '/home/me/.asdf/installs/nodejs/22.11.0/bin/node'
  ])('warns about %s', (nodePath) => {
    const warning = versionScopedInterpreterWarning(nodePath)
    expect(warning).not.toBeNull()
    // Points at the flag that fixes it rather than just naming the problem.
    expect(warning).toContain('--node')
  })

  it.each(['/usr/bin/node', '/usr/local/bin/node', '/home/linuxbrew/.linuxbrew/bin/node'])(
    'stays quiet about the stable path %s',
    (nodePath) => {
      expect(versionScopedInterpreterWarning(nodePath)).toBeNull()
    }
  )
})

describe('realpath resolution', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-realpath-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('resolves a symlinked ancestor, which is what RequiresMountsFor needs', () => {
    // The DSM shape: /var/services/homes -> /volume2/homes, created during boot.
    const volume = join(root, 'volume2', 'homes')
    mkdirSync(join(volume, 'master'), { recursive: true })
    const link = join(root, 'services-homes')
    symlinkSync(volume, link)
    expect(resolveRealPath(join(link, 'master'))).toBe(join(volume, 'master'))
  })

  it('resolves the existing ancestor of a data root that does not exist yet', () => {
    // The usual case at generation time: nothing has created the root, and throwing
    // there would be worse than the symlink this is fixing.
    const volume = join(root, 'volume3')
    mkdirSync(volume, { recursive: true })
    const link = join(root, 'volume3-link')
    symlinkSync(volume, link)
    expect(resolveRealPath(join(link, 'master', '.orca'))).toBe(join(volume, 'master', '.orca'))
  })

  it('returns an entirely absent path unchanged rather than throwing', () => {
    const absent = join(root, 'no', 'such', 'path')
    expect(resolveRealPath(absent)).toBe(absent)
  })
})

describe('--node validation', () => {
  // The version-scoped warning tells operators to pass --node, and --node was the one
  // interpreter source with no validation. The default cannot have this problem, so the
  // gap bit only the people who did what the warning told them to.
  it('warns when a chosen interpreter is not on this host', () => {
    const warning = interpreterOnDiskWarning('/nonexistent/node', true)
    expect(warning).toMatch(/does not exist/)
    expect(warning).toMatch(/203\/EXEC/)
  })

  it('warns when it exists but cannot be executed', () => {
    const notExecutable = join(mkdtempSync(join(tmpdir(), 'orca-node-')), 'node')
    writeFileSync(notExecutable, '', { mode: 0o644 })
    expect(interpreterOnDiskWarning(notExecutable, true)).toMatch(/not executable/)
  })

  it('stays quiet for an interpreter that is present and executable', () => {
    expect(interpreterOnDiskWarning(process.execPath, true)).toBeNull()
  })

  // process.execPath is tautologically on disk, so checking it would only add noise.
  it('says nothing about the default interpreter', () => {
    expect(interpreterOnDiskWarning('/nonexistent/node', false)).toBeNull()
  })
})

describe('socket path budget at generation time', () => {
  // The doctor already calls this critical, but only once the unit is installed. Found on
  // a Synology NAS: print-service emitted a unit pinning a 90-byte root — 113 of 108
  // socket bytes — and then printed the install hint, with nothing on stderr.
  it('warns when the pinned root cannot hold a daemon socket', () => {
    const overBudget = `/volume2/homes/master/.orca-sudotest/${'a'.repeat(53)}`
    const warning = socketPathBudgetWarning(overBudget)
    expect(warning).not.toBeNull()
    expect(warning).toMatch(/\b108\b/)
    expect(warning).toContain(overBudget)
  })

  it('stays quiet for a root that fits', () => {
    expect(socketPathBudgetWarning('/volume2/homes/master/.orca')).toBeNull()
  })

  // The remedy is copied into the operator's next action, so it may name only mechanisms
  // that exist. `--user-data` was neither accepted nor rejected by orcad.
  it('recommends no flag that orcad does not accept', () => {
    const warning = socketPathBudgetWarning(`/tmp/${'a'.repeat(120)}`)
    expect(warning).toContain('ORCA_USER_DATA')
    expect(warning).not.toContain('--user-data')
  })
})
