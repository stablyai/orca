import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { hostTestRestingOptionsRecord } from '../../host/testing/structured-agent-session-host-test-data'
import { AtRestCommandCatalog } from '../at-rest-command-catalog'

function catalogWithSkills() {
  let stamp = 'a'
  let skills = ['old-skill']
  let scans = 0
  let failing = false
  const catalog = new AtRestCommandCatalog({
    label: 'test',
    accepts: () => true,
    resolveWorkspacePath: async () => tmpdir(),
    stamp: async () => stamp,
    scan: async () => {
      scans += 1
      if (failing) {
        throw new Error('skills/list timed out')
      }
      return {
        commands: skills.map((name) => ({ name, kind: 'skill' as const, path: `/s/${name}` })),
        fromAgent: true
      }
    }
  })
  return {
    catalog,
    scans: () => scans,
    install: (name: string, nextStamp: string) => {
      skills = [...skills, name]
      stamp = nextStamp
    },
    failScans: () => {
      failing = true
    }
  }
}

const names = (commands: { name: string }[] | undefined) => commands?.map(({ name }) => name)

describe('at-rest commands before the TTL', () => {
  it('rescans on a menu open once the skill sources changed', async () => {
    const { catalog, scans, install } = catalogWithSkills()
    const record = hostTestRestingOptionsRecord()
    expect(names(await catalog.settled(record, 1_000, true))).toEqual(['old-skill'])

    install('perf-scan', 'b')
    expect(names(await catalog.settled(record, 1_000, true))).toEqual(['old-skill', 'perf-scan'])
    expect(scans()).toBe(2)
    catalog.dispose()
  })

  it('keeps the cached list without a scan while the sources are unchanged', async () => {
    const { catalog, scans } = catalogWithSkills()
    const record = hostTestRestingOptionsRecord()
    await catalog.settled(record, 1_000, true)
    await catalog.settled(record, 1_000, true)
    await catalog.settled(record, 1_000, true)
    expect(scans()).toBe(1)
    catalog.dispose()
  })

  it('leaves a failed rescan to the retry schedule instead of rescanning on every open', async () => {
    const { catalog, scans, install, failScans } = catalogWithSkills()
    const record = hostTestRestingOptionsRecord()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await catalog.settled(record, 1_000, true)
    failScans()
    install('perf-scan', 'b')
    await catalog.settled(record, 1_000, true)
    await catalog.settled(record, 1_000, true)
    await catalog.settled(record, 1_000, true)
    expect(scans()).toBe(2)
    catalog.dispose()
  })
})
