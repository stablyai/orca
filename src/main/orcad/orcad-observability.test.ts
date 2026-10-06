import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { installOrcadObservability } from './orcad-observability'

const CI_ENV = [
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'BUILDKITE',
  'JENKINS_URL',
  'TEAMCITY_VERSION'
]

describe('orcad trace file', () => {
  let dataRoot: string

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'orca-orcad-observability-'))
    setAppEnvironment({
      getPath: (name) => {
        if (name !== 'userData') {
          throw new Error(`unexpected getPath: ${name}`)
        }
        return dataRoot
      },
      getAppPath: () => dataRoot,
      getVersion: () => '0.0.0-test',
      isPackaged: () => true,
      onWillQuit: () => {},
      exit: () => {},
      getAppMetrics: () => []
    })
    // The lane is off in CI and when diagnostics are disabled; this asserts the default host.
    for (const name of [...CI_ENV, 'ORCA_DIAGNOSTICS_DISABLED']) {
      vi.stubEnv(name, '')
    }
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(dataRoot, { recursive: true, force: true })
  })

  const traceRecords = (): { name: string; attributes: Record<string, unknown> }[] =>
    readFileSync(join(dataRoot, 'logs', 'orcad.trace.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))

  const reportLateSettlement = (): void =>
    createStructuredAgentSessionLogger().warn('settling a late dispatch failed', {
      scope: 'late-settlement',
      sessionId: 'session-1',
      error: new Error('disk full')
    })

  it('writes a structured chat failure to its own file under the data root, flushed by close', () => {
    const close = installOrcadObservability()

    reportLateSettlement()
    close()

    expect(traceRecords()).toContainEqual(
      expect.objectContaining({
        name: 'agentSession.late-settlement',
        attributes: expect.objectContaining({ sessionId: 'session-1' }),
        exit: expect.objectContaining({ _tag: 'Failure' })
      })
    )
    expect(existsSync(join(dataRoot, 'logs', 'main.trace.ndjson'))).toBe(false)
  })

  it('flushes what is buffered when the process exits with no cleanup', () => {
    const before = new Set(process.listeners('exit'))
    const close = installOrcadObservability()
    const onExit = process.listeners('exit').filter((listener) => !before.has(listener))
    expect(onExit).toHaveLength(1)

    reportLateSettlement()
    onExit[0]?.call(process, 1)

    expect(traceRecords().map((record) => record.name)).toContain('agentSession.late-settlement')
    close()
    expect(process.listeners('exit')).toHaveLength(before.size)
  })

  it('still starts when the logs folder cannot be opened, with tracing off', () => {
    // A regular file where the folder belongs fails the open as a read-only mount or EACCES does.
    writeFileSync(join(dataRoot, 'logs'), 'not a folder')
    const warn = vi.mocked(console.warn)

    const close = installOrcadObservability()
    reportLateSettlement()
    close()

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[observability] tracing is off'),
      expect.any(Error)
    )
    expect(readFileSync(join(dataRoot, 'logs'), 'utf8')).toBe('not a folder')
  })
})

// Booting orcad here would need its whole runtime; the wiring is pinned the way the agent-status
// store's is, by the entry point's own text.
it('orcad installs the trace file before its runtime and closes it after every quit handler', () => {
  const entry = readFileSync(join(import.meta.dirname, 'orcad-entry.ts'), 'utf8')
  const install = entry.indexOf('closeOrcadObservability = installOrcadObservability()')
  expect(install).toBeGreaterThan(-1)
  expect(install).toBeLessThan(entry.indexOf('new OrcaRuntimeService('))
  const quit = entry.indexOf('      runOrcadQuitHandlers()\n')
  expect(quit).toBeGreaterThan(-1)
  expect(entry.indexOf('      closeOrcadObservability()\n', quit)).toBeGreaterThan(quit)
})
