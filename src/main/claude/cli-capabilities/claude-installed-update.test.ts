import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { claudeBinaryKey, createClaudeCliFlagSupport } from './claude-cli-flag-support'
import { claudeInstalledUpdate } from './claude-installed-update'

let dir: string | undefined

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true })
  }
})

it('asks --version only when the program file changes, and reports only a newer version', async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-claude-update-'))
  const command = join(dir, 'claude')
  await writeFile(command, '')
  const answers = ['2.1.329', null, '2.1.330']
  let probes = 0
  const support = createClaudeCliFlagSupport({
    probe: async () => answers[probes++] ?? null,
    keyOf: claudeBinaryKey,
    budgetMs: 1_500,
    now: () => performance.now()
  })
  const launch = { command, cwd: dir, env: {} }

  expect(await support.version(launch)).toBe('2.1.329')
  expect(await support.version(launch)).toBe('2.1.329')
  expect(probes).toBe(1)
  expect(claudeInstalledUpdate('2.1.329', await support.version(launch))).toBeNull()

  // The Windows updater writes the new binary at the same path, so only its time changes.
  const replace = (minutes: number) => {
    const at = new Date(Date.now() + minutes * 60_000)
    return utimes(command, at, at)
  }
  await replace(1)
  // A binary that gives no version is asked once, not again at every turn end.
  expect(await support.version(launch)).toBeNull()
  expect(await support.version(launch)).toBeNull()
  expect(probes).toBe(2)
  await replace(2)
  const installed = await support.version(launch)
  expect(probes).toBe(3)
  expect(claudeInstalledUpdate('2.1.329', installed)).toEqual({
    runningVersion: '2.1.329',
    installedVersion: '2.1.330'
  })
  // A restarted chat runs the installed version; a downgrade or an unreadable answer is no update.
  expect(claudeInstalledUpdate('2.1.330', installed)).toBeNull()
  expect(claudeInstalledUpdate('2.1.331', installed)).toBeNull()
  expect(claudeInstalledUpdate('2.1.329', null)).toBeNull()
})
