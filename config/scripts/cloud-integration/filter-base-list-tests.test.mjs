import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = path.join(import.meta.dirname, 'filter-base-list-tests.sh')
const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function run(baseListLines, testPaths) {
  const root = mkdtempSync(path.join(tmpdir(), 'base-list-'))
  roots.push(root)
  const baseList = path.join(root, 'base-list.txt')
  if (baseListLines !== null) {
    writeFileSync(baseList, `${baseListLines.join('\n')}\n`)
  }
  const r = spawnSync('bash', [script, baseList], {
    input: `${testPaths.join('\n')}\n`,
    encoding: 'utf8'
  })
  return {
    status: r.status,
    kept: r.stdout.split('\n').filter(Boolean),
    log: r.stderr.split('\n').filter(Boolean)
  }
}

const ON_LIST = 'src/main/agent-hooks/server/testing/replay/spool.test.ts'
const OFF_LIST =
  'src/renderer/src/components/orca-cloud/cloud-workspace-archive-delete-race.test.ts'

describe('premerge base-list filter', () => {
  it('drops a base-list test and logs the skip, while a test off the list is still selected', () => {
    const r = run(['# comment', ON_LIST], [ON_LIST, OFF_LIST])
    expect(r.status).toBe(0)
    expect(r.kept).toEqual([OFF_LIST])
    expect(r.log).toEqual([`premerge: skipping base-list test ${ON_LIST}`])
  })

  it('matches whole lines only: a shared prefix, suffix or folder never skips a test', () => {
    const r = run(
      [ON_LIST],
      [
        'src/main/agent-hooks/server/testing/replay/spool.test.tsx',
        'src/main/agent-hooks/server/testing/replay/other-spool.test.ts',
        'src/main/agent-hooks/server/testing/replay/spool.extra.test.ts',
        'x/src/main/agent-hooks/server/testing/replay/spool.test.ts'
      ]
    )
    expect(r.kept).toHaveLength(4)
    expect(r.log).toEqual([])
  })

  it('treats list entries literally (no regex) and ignores comment lines', () => {
    const r = run(['src/main/a.test.ts', '.*', `# ${OFF_LIST}`], ['src/main/a_test.ts', OFF_LIST])
    expect(r.kept).toEqual(['src/main/a_test.ts', OFF_LIST])
  })

  it('keeps everything when the base list is missing', () => {
    const r = run(null, [ON_LIST, OFF_LIST])
    expect(r.status).toBe(0)
    expect(r.kept).toEqual([ON_LIST, OFF_LIST])
  })
})
