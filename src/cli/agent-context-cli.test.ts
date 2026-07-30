import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runtimeClientConstructorMock } = vi.hoisted(() => ({
  runtimeClientConstructorMock: vi.fn()
}))

vi.mock('./runtime-client', () => ({
  RuntimeClient: class {
    constructor() {
      runtimeClientConstructorMock()
    }
  }
}))

import { main } from './index'

describe('orca agent-context CLI', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    runtimeClientConstructorMock.mockClear()
    process.exitCode = undefined
  })

  afterEach(() => {
    process.exitCode = undefined
  })

  it.each([
    {
      name: 'roots',
      args: ['agent-context', '--roots', '--json'],
      expected: { schemaVersion: 2, view: 'roots' }
    },
    {
      name: 'exact command',
      args: ['agent-context', '--command', 'worktree create', '--json'],
      expected: {
        schemaVersion: 2,
        view: 'command',
        detail: 'full',
        returnedCount: 1
      }
    },
    {
      name: 'prefix summaries',
      args: ['agent-context', '--prefix', 'agent hooks', '--json'],
      expected: { schemaVersion: 2, view: 'prefix', detail: 'summary' }
    },
    {
      name: 'bounded search',
      args: ['agent-context', '--search', 'setup', '--limit', '2', '--json'],
      expected: { schemaVersion: 2, view: 'search', returnedCount: 2 }
    }
  ])('serves $name locally', async ({ args, expected }) => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(args, '/tmp/repo')

    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toMatchObject(expected)
    expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
  })

  it('preserves the legacy full schema', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['agent-context', '--json'], '/tmp/repo')

    const schema = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))
    expect(schema).toMatchObject({
      schemaVersion: 1,
      commandCount: expect.any(Number),
      commands: expect.any(Array)
    })
    expect(schema).not.toHaveProperty('view')
    expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
  })

  it('emits semantically identical compact JSON on one line', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['agent-context', '--roots', '--json'], '/tmp/repo')
    const pretty = String(logSpy.mock.calls.at(-1)?.[0])
    await main(['agent-context', '--roots', '--json', '--compact'], '/tmp/repo')
    const compact = String(logSpy.mock.calls.at(-1)?.[0])

    expect(JSON.parse(compact)).toEqual(JSON.parse(pretty))
    expect(compact).not.toContain('\n')
    expect(pretty).toContain('\n')
  })

  it('advertises progressive discovery without dumping the registry by default', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['agent-context'], '/tmp/repo')

    const output = String(logSpy.mock.calls.at(-1)?.[0])
    expect(output).toContain('agent-context --roots --json')
    expect(output).toContain('agent-context --search')
    expect(output).toContain('Full registry:')
    expect(output).not.toContain('"commands":')
  })

  it('documents query-specific flags in command help', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['agent-context', '--help'], '/tmp/repo')

    const output = String(logSpy.mock.calls.at(-1)?.[0])
    expect(output).toContain('--command <path>')
    expect(output).toContain('--search <terms>')
    expect(output).toContain('--compact')
    expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
  })

  it('returns a structured local error for incompatible query flags', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['agent-context', '--roots', '--search', 'setup', '--json'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toMatchObject({
      id: 'local',
      ok: false,
      error: {
        code: 'invalid_argument',
        message: expect.stringContaining('Pass only one agent-context selector')
      },
      _meta: { runtimeId: null }
    })
    expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
  })
})
