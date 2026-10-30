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
    // Clear diagnostics gates to exercise the default host.
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

  it('writes a structured chat failure to its own file under the data root, flushed by close', async () => {
    const close = installOrcadObservability()

    reportLateSettlement()
    await close()

    expect(traceRecords()).toContainEqual(
      expect.objectContaining({
        name: 'agentSession.late-settlement',
        attributes: expect.objectContaining({ sessionId: 'session-1' }),
        exit: expect.objectContaining({ _tag: 'Failure' })
      })
    )
    expect(existsSync(join(dataRoot, 'logs', 'main.trace.ndjson'))).toBe(false)
  })

  it('flushes what is buffered when the process exits with no cleanup', async () => {
    const before = new Set(process.listeners('exit'))
    const close = installOrcadObservability()
    const onExit = process.listeners('exit').filter((listener) => !before.has(listener))
    expect(onExit).toHaveLength(1)

    reportLateSettlement()
    onExit[0]?.call(process, 1)

    expect(traceRecords().map((record) => record.name)).toContain('agentSession.late-settlement')
    await close()
    expect(process.listeners('exit')).toHaveLength(before.size)
  })

  it('still starts when the logs folder cannot be opened, with tracing off', async () => {
    writeFileSync(join(dataRoot, 'logs'), 'not a folder')
    const warn = vi.mocked(console.warn)

    const close = installOrcadObservability()
    reportLateSettlement()
    await close()

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[observability] tracing is off'),
      expect.any(Error)
    )
    expect(readFileSync(join(dataRoot, 'logs'), 'utf8')).toBe('not a folder')
  })
})
