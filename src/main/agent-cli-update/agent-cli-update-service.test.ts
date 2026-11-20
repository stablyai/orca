import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcess, findOwnAgentCli, latestAgentCliRelease } = vi.hoisted(() => ({
  runProcess: vi.fn(),
  findOwnAgentCli: vi.fn(),
  latestAgentCliRelease: vi.fn()
}))

vi.mock('@orca/process-host', () => ({ runProcess }))
vi.mock('./agent-cli-own-install', () => ({ findOwnAgentCli }))
vi.mock('./agent-cli-latest-release', () => ({ latestAgentCliRelease }))
vi.mock('./agent-cli-model-requirements', () => ({
  readModelsNeedingCliUpdate: async () => []
}))

import { checkAgentCliUpdates } from './agent-cli-update-service'

let dir: string

const printVersion = (version: string) =>
  runProcess.mockResolvedValue({ code: 0, stdout: `Hermes Agent v${version}\n`, stderr: '' })

const installedVersions = async () =>
  (await checkAgentCliUpdates({}, ['hermes'])).map((update) => update.installedVersion)

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  runProcess.mockReset()
  latestAgentCliRelease.mockResolvedValue('0.14.0')
  dir = await mkdtemp(join(tmpdir(), 'agent-cli-update-'))
  // Each test gets its own unchanged launcher, as `hermes update` leaves it.
  const program = join(dir, 'hermes')
  await writeFile(program, '')
  findOwnAgentCli.mockResolvedValue({
    program,
    realPath: program,
    env: {},
    command: 'hermes',
    version: { prefixArgs: [], env: {} }
  })
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

describe('checkAgentCliUpdates', () => {
  it('drops Hermes once `hermes update` replaced the checkout behind an unchanged launcher', async () => {
    printVersion('0.13.0')
    expect(await installedVersions()).toEqual(['0.13.0'])

    printVersion('0.14.0')
    const firstRead = Date.now()
    vi.setSystemTime(firstRead + 60_000)
    expect(await installedVersions()).toEqual(['0.13.0'])

    vi.setSystemTime(firstRead + 11 * 60_000)
    expect(await installedVersions()).toEqual([])
  })

  it('reads Hermes again before listing it behind a release that shipped since the last read', async () => {
    printVersion('0.14.0')
    await installedVersions()

    latestAgentCliRelease.mockResolvedValue('0.15.0')
    printVersion('0.15.0')
    vi.setSystemTime(Date.now() + 11 * 60_000)
    expect(await installedVersions()).toEqual([])
  })

  it('keeps listing Hermes when reading it again times out', async () => {
    printVersion('0.13.0')
    await installedVersions()

    runProcess.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true })
    vi.setSystemTime(Date.now() + 11 * 60_000)
    expect(await installedVersions()).toEqual(['0.13.0'])
    expect(runProcess).toHaveBeenCalledTimes(2)
  })

  it('does not read an up-to-date Hermes again', async () => {
    printVersion('0.14.0')
    await installedVersions()

    vi.setSystemTime(Date.now() + 11 * 60_000)
    await installedVersions()
    expect(runProcess).toHaveBeenCalledTimes(1)
  })
})
