import { describe, expect, it } from 'vitest'
import { autoInstallFromLog } from '../src/environment-builds'

const stored = (...lines: string[]): string =>
  lines.map((data) => JSON.stringify({ data: `${data}\n`, stream: 'stdout' })).join('\n')

describe('autoInstallFromLog (AUTO-ENV-DEPS-LABEL)', () => {
  it('reads the manager and whether it installed', () => {
    expect(
      autoInstallFromLog(stored('Installing dependencies automatically: corepack yarn install --immutable', 'Installed dependencies in 9s.'))
    ).toEqual({ manager: 'yarn', outcome: 'installed' })
    expect(
      autoInstallFromLog(
        stored('Installing dependencies automatically: npm ci', 'Automatic install skipped: npm ci exited with status 1 (often a lockfile out of date).')
      )
    ).toEqual({ manager: 'npm', outcome: 'skipped' })
  })

  it('nothing for a build without an automatic install, or an unreadable log', () => {
    expect(autoInstallFromLog(stored('No install script; the build keeps the cloned repos.'))).toBeNull()
    expect(autoInstallFromLog(stored('Not installed automatically: uv.lock.'))).toBeNull()
    expect(autoInstallFromLog('not json\n{"data":')).toBeNull()
  })
})
