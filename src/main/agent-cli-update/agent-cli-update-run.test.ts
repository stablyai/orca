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

// The CLIs on disk and the one a new chat finds; the updater changes them as a real one would.
let onDisk = new Map<string, string>()
let found = ''
let update = () => {}

beforeEach(() => {
  vi.resetAllMocks()
  findOwnAgentCli.mockImplementation(async () => cliAt(found))
  readAgentCliVersion.mockImplementation(async ({ program }: { program: string }) => ({
    version: onDisk.get(program) ?? null
  }))
  runProcess.mockImplementation(async () => {
    update()
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  })
  latestAgentCliRelease.mockResolvedValue('2.0.0')
})

describe('runAgentCliUpdate', () => {
  it('reads the CLI a new chat finds once the update moved it', async () => {
    onDisk = new Map([['/old/bin/claude', '1.0.0']])
    found = '/old/bin/claude'
    update = () => {
      onDisk.set('/new/bin/claude', '2.0.0')
      found = '/new/bin/claude'
    }

    expect(await runAgentCliUpdate('claude', {})).toEqual({ ok: true })
  })

  it('answers checks asked before and during an update with the updated version', async () => {
    onDisk = new Map([['/slow/bin/claude', '1.0.0']])
    found = '/slow/bin/claude'
    update = () => onDisk.set('/slow/bin/claude', '2.0.0')
    let lookupStarted = () => {}
    const started = new Promise<void>((resolve) => {
      lookupStarted = resolve
    })
    let answerLookup = () => {}
    latestAgentCliRelease.mockImplementationOnce(() => {
      lookupStarted()
      return new Promise((resolve) => {
        answerLookup = () => resolve('2.0.0')
      })
    })

    const before = checkAgentCliUpdates({}, ['claude'])
    await started
    const run = runAgentCliUpdate('claude', {})
    const during = checkAgentCliUpdates({}, ['claude'])
    answerLookup()

    expect(await run).toEqual({ ok: true })
    expect(await before).toEqual([])
    expect(await during).toEqual([])
  })
})
