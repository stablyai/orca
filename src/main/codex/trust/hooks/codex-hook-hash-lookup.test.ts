import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as CodexCommand from '../../../codex-cli/command'
import type * as TrustDerivation from './codex-hook-trust-derivation'
import { fingerprintCodex } from './codex-hook-trust-derivation'
import { writeFileAtomically } from '../../../filesystem/atomic-file-publication'
import type { CodexHookAnswer, CodexHookHashes } from './codex-hook-trust-derivation'

const mocks = vi.hoisted(() => ({
  codexPath: '',
  probeCodexVersion: vi.fn(),
  deriveCodexHookHashes: vi.fn()
}))

vi.mock('../../../codex-cli/command', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexCommand>()),
  resolveCodexCommand: () => mocks.codexPath,
  resolveCodexCommandForSpawn: async () => mocks.codexPath
}))
vi.mock('./codex-hook-trust-derivation', async (importOriginal) => ({
  ...(await importOriginal<typeof TrustDerivation>()),
  probeCodexVersion: mocks.probeCodexVersion,
  deriveCodexHookHashes: mocks.deriveCodexHookHashes
}))
import {
  _internals,
  readKnownCodexHookAnswer,
  resolveCodexHookAnswerForLaunch,
  resolveCodexHookAnswer,
  startCodexHookHashLookup
} from './codex-hook-hash-lookup'
import { getManagedScriptPath } from '../../hooks/definitions/codex-hook-definition'
import { buildCodexHookCommand as getManagedCommand } from '../../hooks/definitions/codex-hook-command-form'

let userData: string
const command = (): string => getManagedCommand(getManagedScriptPath())
const HASHES = { stop: 'sha256:stop' }
const hashesOf = (answer: CodexHookAnswer | null): CodexHookHashes | null =>
  answer?.kind === 'hashes' ? answer.hashes : null

function allowAsking(): void {
  startCodexHookHashLookup(Promise.resolve())
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'orca-codex-hash-lookup-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', userData)
  mocks.codexPath = join(userData, 'codex')
  writeFileSync(mocks.codexPath, 'codex 0.150.1')
  mocks.probeCodexVersion.mockResolvedValue('codex-cli 0.150.1')
  mocks.deriveCodexHookHashes.mockResolvedValue({
    kind: 'hashes',
    codexVersion: 'codex-cli 0.150.1',
    hashes: HASHES
  })
  _internals.resetForTesting()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  rmSync(userData, { recursive: true, force: true })
})

describe('what a lookup may spawn', () => {
  it('never asks Codex outside the app, reading only what the app learned', async () => {
    const answer = await resolveCodexHookAnswer()

    expect(answer).toEqual({ kind: 'pending', failure: 'Orca has not asked Codex yet' })
    expect(mocks.probeCodexVersion).not.toHaveBeenCalled()

    allowAsking()
    await resolveCodexHookAnswer()
    // Simulate a CLI process reading the app's saved answer.
    _internals.resetForTesting()
    expect(hashesOf(await resolveCodexHookAnswer())).toEqual(HASHES)
    expect(mocks.probeCodexVersion).toHaveBeenCalledTimes(1)
  })

  it('re-probes a persisted binary once per process, so a shim retarget gets the new version', async () => {
    allowAsking()
    await resolveCodexHookAnswer()
    await resolveCodexHookAnswer()
    expect(mocks.probeCodexVersion).toHaveBeenCalledTimes(1)
    // Simulate a restart with unchanged shim bytes and an updated Codex.
    _internals.resetForTesting()
    allowAsking()
    mocks.probeCodexVersion.mockResolvedValue('codex-cli 0.160.0')

    await resolveCodexHookAnswer()

    expect(mocks.probeCodexVersion).toHaveBeenCalledTimes(2)
    expect(mocks.deriveCodexHookHashes).toHaveBeenLastCalledWith(
      mocks.codexPath,
      command(),
      'codex-cli 0.160.0'
    )
  })

  it("remembers Codex's refusal per version, and asks again for a new one", async () => {
    allowAsking()
    mocks.deriveCodexHookHashes.mockResolvedValue({
      kind: 'refused',
      codexVersion: 'codex-cli 0.150.1',
      failure: 'Codex 0.150.1 did not recognize Orca status hook'
    })
    await resolveCodexHookAnswer()
    // Simulate a restart retaining the persisted answer.
    _internals.resetForTesting()
    allowAsking()

    expect((await resolveCodexHookAnswer()).kind).toBe('refused')
    expect(mocks.deriveCodexHookHashes).toHaveBeenCalledTimes(1)
    mocks.probeCodexVersion.mockResolvedValue('codex-cli 0.160.0')
    _internals.resetForTesting()
    allowAsking()
    await resolveCodexHookAnswer()
    expect(mocks.deriveCodexHookHashes).toHaveBeenCalledTimes(2)
  })
})

describe('the answer status reads', () => {
  it("does not report a replaced Codex's answer as its own", async () => {
    const originalFingerprint = fingerprintCodex(mocks.codexPath)
    expect(originalFingerprint).not.toBeNull()
    allowAsking()
    await resolveCodexHookAnswer()
    // Replace the file itself so equal-size writes cannot reuse its cached identity.
    writeFileAtomically(mocks.codexPath, 'codex 0.161.0')
    expect(fingerprintCodex(mocks.codexPath)).not.toBe(originalFingerprint)

    expect(readKnownCodexHookAnswer()).toBeNull()
  })
})

describe('when a lookup runs', () => {
  it('lets a launch go ahead without an answer that is still on its way', async () => {
    allowAsking()
    mocks.probeCodexVersion.mockImplementation(() => new Promise(() => {}))

    await expect(resolveCodexHookAnswerForLaunch(10)).resolves.toBeNull()
  })

  it('makes a launch before PATH hydration wait for it, then ask', async () => {
    let hydrate: () => void = () => {}
    startCodexHookHashLookup(
      new Promise<void>((resolve) => {
        hydrate = resolve
      })
    )

    const launch = resolveCodexHookAnswerForLaunch(5_000)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(mocks.probeCodexVersion).not.toHaveBeenCalled()
    hydrate()

    expect(hashesOf(await launch)).toEqual(HASHES)
  })
})
