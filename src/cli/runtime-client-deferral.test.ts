import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { constructorArgsMock, callMock, getCliStatusMock } = vi.hoisted(() => ({
  constructorArgsMock: vi.fn(),
  callMock: vi.fn(),
  getCliStatusMock: vi.fn()
}))

// Why: `main` reaches RuntimeClient through `await import('./runtime-client.js')`
// now. Mocking the same specifier the eager import used proves the dynamic
// import still resolves to the module the 10 existing vi.mock suites target.
// Why: --environment is now resolved against the paired-environment store before the client is
// constructed, so a forwarding assertion needs an environment that actually resolves.
vi.mock('./runtime/environments', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    listEnvironments: () => [{ id: 'env-1', name: 'env-1' }]
  }
})

vi.mock('./runtime-client', () => {
  class RuntimeClient {
    call = callMock
    getCliStatus = getCliStatusMock
    openOrca = vi.fn()

    constructor(...args: unknown[]) {
      constructorArgsMock(...args)
    }
  }
  return { RuntimeClient, getDefaultUserDataPath: () => '/tmp/orca-user-data' }
})

import { main } from './index'
import * as dispatchModule from './dispatch'

const CLI_DIR = __dirname

describe('RuntimeClient module-graph deferral', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    constructorArgsMock.mockClear()
    callMock.mockReset()
    getCliStatusMock.mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
    vi.unstubAllEnvs()
    process.exitCode = 0
  })

  // Why: the whole point of the change. These six modules load on EVERY
  // invocation, so a value-import of the barrel from any of them drags the
  // RuntimeClient graph (zod, ws, tweetnacl) back onto the --help path.
  it.each([
    'args.ts',
    'flags.ts',
    'dispatch.ts',
    'format.ts',
    'selectors.ts',
    'execution-host-flag.ts'
  ])('%s imports error classes from ./runtime/types, not the barrel', (file) => {
    const source = readFileSync(join(CLI_DIR, file), 'utf8')
    const valueImports = source
      .split('\n')
      .filter((line) => line.startsWith('import ') && line.includes("'./runtime-client'"))
    for (const line of valueImports) {
      expect(line, `${file}: "${line}" must be type-only`).toMatch(/^import type /)
    }
    expect(source).toContain("} from './runtime/types'")
  })

  it('index.ts has no eager value-import of the runtime client', () => {
    const source = readFileSync(join(CLI_DIR, 'index.ts'), 'utf8')
    expect(source).toContain("import type { RuntimeClient } from './runtime-client'")
    expect(source).not.toMatch(/^import \{[^}]*RuntimeClient[^}]*\} from '\.\/runtime-client'/m)
    expect(source).toContain("await import('./runtime-client.js')")
  })

  it('constructs no client for --help', async () => {
    await main(['--help'], '/tmp/repo')
    expect(constructorArgsMock).not.toHaveBeenCalled()
  })

  it('constructs no client for an unknown flag', async () => {
    await main(['worktree', 'list', '--nope'], '/tmp/repo')
    expect(process.exitCode).toBe(1)
    expect(constructorArgsMock).not.toHaveBeenCalled()
  })

  // Why: `agent hooks on|off` are the only commands that both sit in a
  // suppressed group and touch ctx.client, and they rewrite the real ~/.claude
  // hook config — so the byte-for-byte equivalence script cannot invoke them.
  // Assert the constructor arguments directly instead: `null` (not `undefined`)
  // is what stops the ORCA_* env fallback re-activating for local-only groups.
  //
  // `constructs` is declared per case and asserted BEFORE the args, because
  // only `agent hooks off` reads ctx.client. Looping over `mock.calls` alone
  // would pass vacuously for the other four, and would keep passing if the one
  // case that carries the null-vs-undefined coverage stopped constructing at
  // all. The zero rows are not filler: they assert the deferral itself — a
  // local-only group must reach its handler without building a client.
  const SUPPRESSED_GROUPS: [name: string, argv: string[], constructs: number][] = [
    ['agent', ['agent', 'hooks', 'off'], 1],
    ['environment', ['environment', 'list'], 0],
    ['serve', ['serve'], 0],
    ['vm', ['vm', 'recipe', 'doctor'], 0],
    ['agent-context', ['agent-context'], 0]
  ]

  it.each(SUPPRESSED_GROUPS)(
    'constructs exactly %s expected clients, with null remote selection',
    async (_name, argv, constructs) => {
      vi.stubEnv('ORCA_PAIRING_CODE', 'pairing-code')
      vi.stubEnv('ORCA_ENVIRONMENT', 'some-environment')
      getCliStatusMock.mockResolvedValue({ result: { runtime: { reachable: false } } })

      await main(argv, '/tmp/repo')

      const calls = constructorArgsMock.mock.calls
      expect(calls.length, `${argv.join(' ')} client constructions`).toBe(constructs)
      for (const call of calls) {
        expect(call[2], `${argv.join(' ')} pairing code`).toBeNull()
        expect(call[3], `${argv.join(' ')} environment`).toBeNull()
      }
    }
  )

  // Why: four of the five groups above never read ctx.client, so they can only
  // assert that no client is built — not that suppression forwards `null`.
  // Stub dispatch and read the getter directly so every group asserts the
  // constructor arguments unconditionally, exactly once.
  it.each(SUPPRESSED_GROUPS.map(([name, argv]) => [name, argv] as const))(
    'forwards null remote selection to the client %s would build',
    async (_name, argv) => {
      vi.stubEnv('ORCA_PAIRING_CODE', 'pairing-code')
      vi.stubEnv('ORCA_ENVIRONMENT', 'some-environment')
      const dispatchSpy = vi.spyOn(dispatchModule, 'dispatch').mockResolvedValue(undefined)
      try {
        await main(argv, '/tmp/repo')

        const ctx = dispatchSpy.mock.calls.at(-1)?.[1]
        expect(dispatchSpy, `${argv.join(' ')} reached dispatch`).toHaveBeenCalledTimes(1)
        void ctx?.client
        expect(constructorArgsMock, `${argv.join(' ')} constructions`).toHaveBeenCalledTimes(1)
        const [, , pairingCode, environment] = constructorArgsMock.mock.calls[0]
        expect(pairingCode, `${argv.join(' ')} pairing code`).toBeNull()
        expect(environment, `${argv.join(' ')} environment`).toBeNull()
      } finally {
        dispatchSpy.mockRestore()
      }
    }
  )

  // Why: the mirror — the same stubbed-dispatch probe must show `undefined`
  // (not `null`) for a non-suppressed group, or the assertion above would pass
  // for a build that suppressed EVERY command's env fallback.
  it('forwards undefined remote selection for a non-suppressed group', async () => {
    vi.stubEnv('ORCA_PAIRING_CODE', 'pairing-code')
    const dispatchSpy = vi.spyOn(dispatchModule, 'dispatch').mockResolvedValue(undefined)
    try {
      await main(['worktree', 'list'], '/tmp/repo')

      void dispatchSpy.mock.calls.at(-1)?.[1]?.client
      expect(constructorArgsMock).toHaveBeenCalledTimes(1)
      const [, , pairingCode, environment] = constructorArgsMock.mock.calls[0]
      expect(pairingCode).toBeUndefined()
      expect(environment).toBeUndefined()
    } finally {
      dispatchSpy.mockRestore()
    }
  })

  // Why: the mirror of the above — for every other command the env fallback
  // MUST stay live, which the RuntimeClient default parameters implement. That
  // only works if `undefined` is forwarded.
  it('forwards undefined for non-suppressed commands so the env fallback applies', async () => {
    callMock.mockResolvedValue({ result: { worktrees: [] } })

    await main(['worktree', 'list', '--json'], '/tmp/repo')

    expect(constructorArgsMock).toHaveBeenCalled()
    const [, , pairingCode, environment] = constructorArgsMock.mock.calls[0]
    expect(pairingCode).toBeUndefined()
    expect(environment).toBeUndefined()
  })

  it('forwards explicit --pairing-code and --environment values verbatim', async () => {
    callMock.mockResolvedValue({ result: { worktrees: [] } })

    await main(['worktree', 'list', '--pairing-code', 'code-1', '--json'], '/tmp/repo')
    expect(constructorArgsMock.mock.calls[0][2]).toBe('code-1')
    expect(constructorArgsMock.mock.calls[0][3]).toBeUndefined()

    constructorArgsMock.mockClear()
    await main(['worktree', 'list', '--environment', 'env-1', '--json'], '/tmp/repo')
    expect(constructorArgsMock.mock.calls[0][2]).toBeUndefined()
    expect(constructorArgsMock.mock.calls[0][3]).toBe('env-1')
  })

  // Why: the getter is memoised; a dynamic import inside it would have made it
  // async and changed every handler signature.
  it('reuses one client instance across repeated ctx.client reads', async () => {
    callMock.mockResolvedValue({ result: { worktrees: [] } })

    await main(['worktree', 'list', '--json'], '/tmp/repo')

    expect(constructorArgsMock).toHaveBeenCalledTimes(1)
  })
})
