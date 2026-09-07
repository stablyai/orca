import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('ExternalAutomationsHandler referenced log paths', () => {
  let hermesHome: string
  let previousHermesHome: string | undefined

  beforeEach(async () => {
    previousHermesHome = process.env.HERMES_HOME
    hermesHome = await mkdtemp(join(tmpdir(), 'relay-hermes-output-'))
    process.env.HERMES_HOME = hermesHome
    vi.resetModules()
  })

  afterEach(async () => {
    if (previousHermesHome === undefined) {
      delete process.env.HERMES_HOME
    } else {
      process.env.HERMES_HOME = previousHermesHome
    }
    await rm(hermesHome, { recursive: true, force: true })
    vi.resetModules()
  })

  it('hydrates referenced logs in valid dot-dot-prefixed Hermes subdirectories', async () => {
    const logPath = join(hermesHome, '..logs', 'x-monitor.log')
    await mkdir(dirname(logPath), { recursive: true })
    await writeFile(logPath, 'remote dot-dot-prefixed log line\n', 'utf-8')

    const { readHermesReferencedLogFile } = await import('./hermes-output-run-files')

    const result = await readHermesReferencedLogFile(`Latest log path: ${logPath}
Run summary: monitor automation completed successfully.`)

    expect(result?.content).toBe('remote dot-dot-prefixed log line\n')
  })
})
