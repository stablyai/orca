import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BackgroundDistroGateModule from '../../../wsl-background-distro-gate'
import { wslDistroHoldMessage } from '../../../../shared/wsl-distro-stopped-hold'
import { prepareRuntimePtySpawn } from './spawn-preflight'
import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from './spawn-state'
import { makeRuntimePtySpawnTestDeps } from './spawn-preflight-test-deps-fixture'
import { isWslUserActFor } from '../../../wsl/wsl-user-act-scope'

const mocks = vi.hoisted(() => ({
  readWslDistroRunningState: vi.fn<() => Promise<'running' | 'stopped' | 'unverifiable'>>()
}))
vi.mock('../../../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof BackgroundDistroGateModule>()),
  readWslDistroRunningState: mocks.readWslDistroRunningState
}))

const WSL_CWD = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
const hostPlatform = process.platform

async function prepare(
  args: Partial<RuntimePtySpawnArgs>,
  deps = makeRuntimePtySpawnTestDeps()
): Promise<void> {
  const ctx = createRuntimePtySpawnState(deps, {
    cols: 120,
    rows: 40,
    cwd: WSL_CWD,
    ...args
  })
  try {
    await prepareRuntimePtySpawn(ctx)
  } finally {
    ctx.finishTerminalInstall()
  }
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  mocks.readWslDistroRunningState.mockReset()
  mocks.readWslDistroRunningState.mockResolvedValue('stopped')
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
})

describe("main's background start in a stopped WSL distro (E9)", () => {
  it('holds in the shared preflight, whichever provider would run it', async () => {
    await expect(prepare({})).rejects.toThrow(wslDistroHoldMessage('Ubuntu', 'stopped'))
    expect(mocks.readWslDistroRunningState).toHaveBeenCalledOnce()
  })

  it('names an unanswered read as unverifiable', async () => {
    mocks.readWslDistroRunningState.mockResolvedValue('unverifiable')
    await expect(prepare({})).rejects.toThrow(wslDistroHoldMessage('Ubuntu', 'unverifiable'))
  })

  it("never holds the user's start", async () => {
    await expect(prepare({ wslUserAct: true })).resolves.toBeUndefined()
    expect(mocks.readWslDistroRunningState).not.toHaveBeenCalled()
  })

  it('starts once the distro runs', async () => {
    mocks.readWslDistroRunningState.mockResolvedValue('running')
    await expect(prepare({})).resolves.toBeUndefined()
  })
})

describe('host env prep after the startup hold (E9)', () => {
  // Prep runs after the hold read; the distro may stop in between, so only a user act may wake it.
  async function userActDuringPrep(args: Partial<RuntimePtySpawnArgs>): Promise<boolean[]> {
    mocks.readWslDistroRunningState.mockResolvedValue('running')
    const seen: boolean[] = []
    const deps = makeRuntimePtySpawnTestDeps()
    deps.prepareCodexResumeHome = () => {
      seen.push(isWslUserActFor('Ubuntu'))
      return null
    }
    await prepare({ command: 'codex', ...args }, deps)
    return seen
  }

  it('gives a background start no user-act scope', async () => {
    expect(await userActDuringPrep({})).toEqual([false])
  })

  it("keeps the user's start a user act", async () => {
    expect(await userActDuringPrep({ wslUserAct: true })).toEqual([true])
  })
})
