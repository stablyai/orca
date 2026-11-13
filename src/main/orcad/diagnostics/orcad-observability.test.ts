import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../../shared/app-environment'
import { createStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
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
})
