import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findOwnAgentCli, latestAgentCliRelease, readAgentCliVersion, runProcess } = vi.hoisted(
  () => ({
    findOwnAgentCli: vi.fn(),
    latestAgentCliRelease: vi.fn(),
    readAgentCliVersion: vi.fn(),
    runProcess: vi.fn()
  })
)

vi.mock('@orca/process-host', () => ({ runProcess }))
vi.mock('./agent-cli-own-install', () => ({ findOwnAgentCli }))
vi.mock('../agent-launch/preflight/agent-cli-version-probe', () => ({ readAgentCliVersion }))
// The launcher file stays put while the version behind it changes.
vi.mock('../native-chat/agent-model-catalog/agent-model-catalog-input-stamp', () => ({
  agentModelCatalogInputStamp: async () => 'launcher'
}))
vi.mock('../native-chat/agent-model-catalog/agent-model-catalog-store', () => ({
  agentModelCatalogStore: { expireLaunchScopes: () => {} }
}))
vi.mock('./agent-cli-latest-release', () => ({ latestAgentCliRelease }))
vi.mock('./agent-cli-model-requirements', () => ({ readModelsNeedingCliUpdate: async () => [] }))

import { checkAgentCliUpdates, runAgentCliUpdate } from './agent-cli-update-service'

const cliAt = (program: string) => ({
  program,
  realPath: program,
  env: {},
  command: 'claude',
  version: { prefixArgs: [], env: {} }
})

beforeEach(() => {
  vi.resetAllMocks()
  runProcess.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false })
  latestAgentCliRelease.mockResolvedValue('2.0.0')
})

describe('runAgentCliUpdate', () => {
  it('reads the CLI a new chat finds once the update moved it', async () => {
    findOwnAgentCli
      .mockResolvedValueOnce(cliAt('/old/bin/claude'))
      .mockResolvedValueOnce(cliAt('/new/bin/claude'))
    readAgentCliVersion.mockImplementation(async ({ program }) => ({
      version: program === '/new/bin/claude' ? '2.0.0' : '1.0.0'
    }))

    expect(await runAgentCliUpdate('claude', {})).toEqual({ ok: true })
  })

  it('answers a check asked during an update with the updated version', async () => {
    findOwnAgentCli.mockResolvedValue(cliAt('/npm/bin/claude'))
    let finishUpdate = () => {}
    runProcess.mockReturnValueOnce(
      new Promise((resolve) => {
        finishUpdate = () => resolve({ code: 0, stdout: '', stderr: '', timedOut: false })
      })
    )
    readAgentCliVersion
      .mockResolvedValueOnce({ version: '1.0.0' })
      .mockResolvedValueOnce({ version: '2.0.0' })

    const run = runAgentCliUpdate('claude', {})
    await vi.waitFor(() => expect(runProcess).toHaveBeenCalled())
    const check = checkAgentCliUpdates({}, ['claude'])
    // Lets the check run as far as it can while the updater is still going.
    await new Promise((resolve) => setImmediate(resolve))
    finishUpdate()

    expect(await run).toEqual({ ok: true })
    expect(await check).toEqual([])
  })

  it('answers a check that was still running when an update began with the updated version', async () => {
    findOwnAgentCli.mockResolvedValue(cliAt('/slow/bin/claude'))
    readAgentCliVersion
      .mockResolvedValueOnce({ version: '1.0.0' })
      .mockResolvedValueOnce({ version: '2.0.0' })
    let answerLookup = () => {}
    latestAgentCliRelease.mockReturnValueOnce(
      new Promise((resolve) => {
        answerLookup = () => resolve('2.0.0')
      })
    )

    const check = checkAgentCliUpdates({}, ['claude'])
    await vi.waitFor(() => expect(latestAgentCliRelease).toHaveBeenCalled())
    const run = runAgentCliUpdate('claude', {})
    const later = checkAgentCliUpdates({}, ['claude'])
    answerLookup()

    expect(await run).toEqual({ ok: true })
    expect(await check).toEqual([])
    expect(await later).toEqual([])
  })
})
