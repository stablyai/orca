import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as CodexCommand from '../codex-cli/command'
import type * as TrustDerivation from './codex-hook-trust-derivation'
import type { CodexHookAnswer, CodexHookHashes } from './codex-hook-trust-derivation'

const mocks = vi.hoisted(() => ({
  codexPath: '',
  probeCodexVersion: vi.fn(),
  deriveCodexHookHashes: vi.fn()
}))

vi.mock('../codex-cli/command', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexCommand>()),
  resolveCodexCommand: () => mocks.codexPath
}))
vi.mock('./codex-hook-trust-derivation', async (importOriginal) => ({
  ...(await importOriginal<typeof TrustDerivation>()),
  probeCodexVersion: mocks.probeCodexVersion,
  deriveCodexHookHashes: mocks.deriveCodexHookHashes
}))

import {
  _internals,
  lookupCodexHookAnswer,
  readKnownCodexHookAnswer,
  resolveCodexHookAnswerForLaunch,
  resolveCodexHookAnswer,
  startCodexHookHashLookup
} from './codex-hook-hash-lookup'
import { getCodexHookTrustMemoPath } from './codex-hook-trust-memo'
import { getManagedCommand, getManagedScriptPath } from './codex-hook-definition'

// Why this file: finding Codex's hash spawns Codex, so the lookup must ask at
// most once per binary at a time, hold a failure back for a while, and never
// ask outside the app.

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
    // Why: a new process, as the CLI's is: it reads the file the app wrote.
    _internals.resetForTesting()
    expect(hashesOf(await resolveCodexHookAnswer())).toEqual(HASHES)
    expect(mocks.probeCodexVersion).toHaveBeenCalledTimes(1)
  })

  it('asks once for concurrent callers, and holds a probe with no version back for a while', async () => {
    allowAsking()
    mocks.probeCodexVersion.mockResolvedValue(null)

    await Promise.all([resolveCodexHookAnswer(), resolveCodexHookAnswer()])
    const held = await resolveCodexHookAnswer()

    expect(mocks.probeCodexVersion).toHaveBeenCalledTimes(1)
    expect(held.kind).toBe('pending')
  })

  it('spawns a failing `codex --version` once for a burst of lookups', async () => {
    allowAsking()
    mocks.probeCodexVersion.mockRejectedValue(new Error('spawn codex EACCES'))

    for (let lookup = 0; lookup < 5; lookup += 1) {
      await resolveCodexHookAnswer()
    }

    expect(mocks.probeCodexVersion).toHaveBeenCalledTimes(1)
  })

  it("asks again for another hook command, since Codex's hash depends on it", async () => {
    allowAsking()
    await lookupCodexHookAnswer(mocks.codexPath, command())

    await lookupCodexHookAnswer(mocks.codexPath, '/other/codex-hook.sh')

    expect(mocks.probeCodexVersion).toHaveBeenCalledTimes(2)
  })

  it('asks again once the hold-back window has passed', async () => {
    allowAsking()
    mocks.probeCodexVersion.mockResolvedValueOnce(null)
    await resolveCodexHookAnswer()
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)

    expect(hashesOf(await resolveCodexHookAnswer())).toEqual(HASHES)
    expect(mocks.probeCodexVersion).toHaveBeenCalledTimes(2)
  })

  it('re-probes a persisted binary once per process, so a shim retarget gets the new version', async () => {
    allowAsking()
    await resolveCodexHookAnswer()
    await resolveCodexHookAnswer()
    expect(mocks.probeCodexVersion).toHaveBeenCalledTimes(1)
    // Why: a new process, the same shim bytes, a different codex behind them.
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

  it("reuses a saved version's hashes for a new binary of that version, with no hooks/list", async () => {
    allowAsking()
    await resolveCodexHookAnswer()
    writeFileSync(mocks.codexPath, 'codex 0.150.1, reinstalled')

    expect(hashesOf(await resolveCodexHookAnswer())).toEqual(HASHES)
    expect(mocks.probeCodexVersion).toHaveBeenCalledTimes(2)
    expect(mocks.deriveCodexHookHashes).toHaveBeenCalledTimes(1)
  })

  it('keeps an in-process answer when the memo file cannot be saved', async () => {
    writeFileSync(getCodexHookTrustMemoPath(), '{}')
    chmodSync(userData, 0o500)
    try {
      allowAsking()
      await resolveCodexHookAnswer()
      await resolveCodexHookAnswer()
    } finally {
      chmodSync(userData, 0o700)
    }

    expect(mocks.probeCodexVersion).toHaveBeenCalledTimes(1)
  })

  it('treats a codex not found as temporary, and asks as soon as it appears', async () => {
    allowAsking()
    rmSync(mocks.codexPath)

    const missing = await resolveCodexHookAnswer()

    expect(missing).toEqual({
      kind: 'pending',
      failure: `Orca could not find Codex at ${mocks.codexPath}`,
      codexMissing: true
    })
    writeFileSync(mocks.codexPath, 'codex 0.150.1')
    expect(hashesOf(await resolveCodexHookAnswer())).toEqual(HASHES)
    expect(mocks.probeCodexVersion).toHaveBeenCalledTimes(1)
  })

  it("remembers Codex's refusal per version, and asks again for a new one", async () => {
    allowAsking()
    mocks.deriveCodexHookHashes.mockResolvedValue({
      kind: 'refused',
      codexVersion: 'codex-cli 0.150.1',
      failure: 'Codex 0.150.1 did not recognize Orca status hook'
    })
    await resolveCodexHookAnswer()
    // Why: a new process, as after a restart; the version's answer is saved.
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

  it('reports the answer for the codex on PATH, not one another binary gave', async () => {
    allowAsking()
    await resolveCodexHookAnswer()
    expect(hashesOf(readKnownCodexHookAnswer())).toEqual(HASHES)

    mocks.codexPath = join(userData, 'other-codex')
    writeFileSync(mocks.codexPath, 'codex 0.150.1')

    expect(readKnownCodexHookAnswer()).toBeNull()
  })
})

describe('the answer status reads', () => {
  it("does not report a replaced Codex's answer as its own", async () => {
    allowAsking()
    await resolveCodexHookAnswer()
    // Why new bytes: a codex the lookup has not asked about yet.
    writeFileSync(mocks.codexPath, 'codex 0.161.0')

    expect(readKnownCodexHookAnswer()).toBeNull()
  })

  it('says Codex was not found, in a process that may not ask too', () => {
    rmSync(mocks.codexPath)

    expect(readKnownCodexHookAnswer()).toEqual({
      kind: 'pending',
      failure: `Orca could not find Codex at ${mocks.codexPath}`,
      codexMissing: true
    })
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
