import { afterEach, describe, expect, it, vi } from 'vitest'
import { runTuiCommand, type TuiCommandDeps } from './tui'
import type { HandlerContext } from '../dispatch'
import type { RunTuiOptions, TuiBundle } from '../tui/tui-runtime-contract'
import { RuntimeClientError } from '../runtime-client'

type FakeClient = {
  isRemote: boolean
  getCliStatus: () => Promise<{ result: { runtime: { reachable: boolean } } }>
  openOrca?: () => Promise<unknown>
}

function makeCtx(
  client: FakeClient,
  flags: Map<string, string | boolean> = new Map()
): HandlerContext {
  return {
    flags,
    client: client as unknown as HandlerContext['client'],
    cwd: process.cwd(),
    json: false
  }
}

function makeDeps(overrides: Partial<TuiCommandDeps> = {}): {
  deps: TuiCommandDeps
  runTui: ReturnType<typeof vi.fn>
  stderr: string[]
} {
  const runTui = vi.fn<(o: RunTuiOptions) => Promise<void>>().mockResolvedValue(undefined)
  const stderr: string[] = []
  const bundle: TuiBundle = { runTui }
  const deps: TuiCommandDeps = {
    isTty: () => true,
    loadBundle: vi.fn<() => Promise<TuiBundle>>().mockResolvedValue(bundle),
    writeStderr: (text) => {
      stderr.push(text)
    },
    ...overrides
  }
  return { deps, runTui, stderr }
}

const reachable: FakeClient = {
  isRemote: false,
  getCliStatus: async () => ({ result: { runtime: { reachable: true } } })
}

afterEach(() => {
  process.exitCode = undefined
})

describe('runTuiCommand', () => {
  it('launches the TUI when on a TTY against a reachable runtime', async () => {
    const { deps, runTui } = makeDeps()
    await runTuiCommand(makeCtx(reachable), deps)
    expect(runTui).toHaveBeenCalledTimes(1)
    expect(runTui.mock.calls[0][0]).toMatchObject({ isRemote: false, noAltScreen: false })
  })

  it('passes noAltScreen through from the --no-alt-screen flag', async () => {
    const { deps, runTui } = makeDeps()
    await runTuiCommand(makeCtx(reachable, new Map([['no-alt-screen', true]])), deps)
    expect(runTui.mock.calls[0][0].noAltScreen).toBe(true)
  })

  it('reflects a remote runtime in the launch options', async () => {
    const { deps, runTui } = makeDeps()
    const remote: FakeClient = { ...reachable, isRemote: true }
    await runTuiCommand(makeCtx(remote), deps)
    expect(runTui.mock.calls[0][0].isRemote).toBe(true)
  })

  it('refuses to launch and exits non-zero when stdout is not a TTY', async () => {
    const { deps, runTui, stderr } = makeDeps({ isTty: () => false })
    await runTuiCommand(makeCtx(reachable), deps)
    expect(runTui).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(stderr.join('')).toContain('interactive terminal')
  })

  it('starts Orca when the local runtime is unreachable, then launches the TUI', async () => {
    const { deps, runTui, stderr } = makeDeps()
    const openOrca = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined)
    const unreachable: FakeClient = {
      isRemote: false,
      getCliStatus: async () => ({ result: { runtime: { reachable: false } } }),
      openOrca
    }
    await runTuiCommand(makeCtx(unreachable), deps)
    expect(openOrca).toHaveBeenCalledTimes(1)
    expect(stderr.join('')).toContain('starting')
    expect(runTui).toHaveBeenCalledTimes(1)
  })

  it('throws when a remote runtime is unreachable and never loads the bundle', async () => {
    const { deps, runTui } = makeDeps()
    const unreachable: FakeClient = {
      isRemote: true,
      getCliStatus: async () => ({ result: { runtime: { reachable: false } } })
    }
    await expect(runTuiCommand(makeCtx(unreachable), deps)).rejects.toBeInstanceOf(
      RuntimeClientError
    )
    expect(runTui).not.toHaveBeenCalled()
    expect(deps.loadBundle).not.toHaveBeenCalled()
  })
})
