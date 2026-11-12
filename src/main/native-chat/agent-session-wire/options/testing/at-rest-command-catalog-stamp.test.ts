import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { hostTestRestingOptionsRecord } from '../../host/testing/structured-agent-session-host-test-data.test-fixture'
import { AtRestCommandCatalog } from '../at-rest-command-catalog'

function catalogWithSkills() {
  let stamp = 'a'
  let skills = ['old-skill']
  const catalog = new AtRestCommandCatalog({
    label: 'test',
    accepts: () => true,
    resolveWorkspacePath: async () => tmpdir(),
    stamp: async () => stamp,
    scan: async () => {
      return {
        commands: skills.map((name) => ({ name, kind: 'skill' as const, path: `/s/${name}` })),
        fromAgent: true
      }
    }
  })
  return {
    catalog,
    install: (name: string, nextStamp: string) => {
      skills = [...skills, name]
      stamp = nextStamp
    }
  }
}

const names = (commands: { name: string }[] | undefined) => commands?.map(({ name }) => name)

describe('at-rest commands before the TTL', () => {
  it('rescans on a menu open once the skill sources changed', async () => {
    const { catalog, install } = catalogWithSkills()
    const record = hostTestRestingOptionsRecord()
    expect(names(await catalog.settled(record, 1_000, true))).toEqual(['old-skill'])

    install('perf-scan', 'b')
    expect(names(await catalog.settled(record, 1_000, true))).toEqual(['old-skill', 'perf-scan'])
    catalog.dispose()
  })
})
