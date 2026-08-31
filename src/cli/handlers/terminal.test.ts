import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import type { createReadStream as NodeCreateReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_INPUT_MAX_BYTES,
  TERMINAL_INPUT_TOO_LARGE_ERROR
} from '../../shared/terminal-input'
import type { RuntimeClient } from '../runtime-client'
import { parseArgs } from '../args'
import { printHelp } from '../help'
import { COMMAND_SPECS } from '../specs'
import { TERMINAL_HANDLERS } from './terminal'

const { createReadStreamMock } = vi.hoisted(() => ({ createReadStreamMock: vi.fn() }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<
    Record<string, unknown> & { createReadStream: typeof NodeCreateReadStream }
  >()
  createReadStreamMock.mockImplementation(actual.createReadStream)
  return { ...actual, createReadStream: createReadStreamMock }
})

const ORIGINAL_EXIT_CODE = process.exitCode

describe('terminal close CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps the default close RPC unchanged', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { close: { handle: 'term-1', tabId: 'tab-1', ptyKilled: true } }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal close']({
      flags: new Map([['terminal', 'term-1']]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenCalledWith('terminal.close', { terminal: 'term-1' })
  })

  it('routes --tab to the durable whole-tab RPC', async () => {
    const parsed = parseArgs(['terminal', 'close', '--terminal', 'term-1', '--tab'])
    const call = vi.fn().mockResolvedValue({
      result: {
        close: {
          handle: 'term-1',
          tabId: 'tab-1',
          closeMode: 'tab',
          ptyKilled: false
        }
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal close']({
      flags: parsed.flags,
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(parsed.flags.get('tab')).toBe(true)
    expect(call).toHaveBeenCalledWith('terminal.closeTab', { terminal: 'term-1' })
  })

  it('documents that --tab waits for durable persistence', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    printHelp(COMMAND_SPECS, ['terminal', 'close'])

    const help = String(log.mock.calls[0]?.[0])
    expect(help).toContain('orca terminal close [--terminal <handle>] [--tab] [--json]')
    expect(help).toContain('durable persistence')
  })
})

describe('terminal send CLI', () => {
  const tempDirectories: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = ORIGINAL_EXIT_CODE
    return Promise.all(
      tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
    )
  })

  async function createTempDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'orca-terminal-send-'))
    tempDirectories.push(directory)
    return directory
  }

  it('marks combined text and Enter as an agent prompt candidate', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { send: { handle: 'term-1', accepted: true, bytesWritten: 7 } }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['text', 'review'],
        ['enter', true]
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenCalledWith('terminal.send', {
      terminal: 'term-1',
      text: 'review',
      enter: true,
      interrupt: false,
      agentPrompt: true,
      client: { id: 'orca-cli', type: 'desktop' }
    })
  })

  it('explains that Structured Chat blocked a refused send and how to recover', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        send: {
          handle: 'term-1',
          accepted: false,
          bytesWritten: 0,
          agentSessionRefusal: {
            code: 'agent_session_conflict',
            sessionId: 'session-1',
            ownerRuntimeKind: 'native',
            handoffStage: null,
            ownerPid: 4242,
            runtimeFence: 7
          }
        }
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    process.exitCode = undefined

    await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['text', 'review'],
        ['enter', true]
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: false
    })

    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/Structured Chat.*Switch it to Terminal.*orca terminal send/s)
    )
    expect(process.exitCode).toBe(1)
  })

  it('keeps text-only and bare Enter sends as direct terminal input', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { send: { handle: 'term-1', accepted: true, bytesWritten: 1 } }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['text', 'x']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })
    await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['enter', true]
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenNthCalledWith(1, 'terminal.send', {
      terminal: 'term-1',
      text: 'x',
      enter: false,
      interrupt: false,
      client: { id: 'orca-cli', type: 'desktop' }
    })
    expect(call).toHaveBeenNthCalledWith(2, 'terminal.send', {
      terminal: 'term-1',
      text: undefined,
      enter: true,
      interrupt: false,
      client: { id: 'orca-cli', type: 'desktop' }
    })
  })

  it('reads multi-line UTF-8 text from a relative file', async () => {
    const cwd = await createTempDirectory()
    await writeFile(join(cwd, 'prompt.txt'), 'first line\nsegundo café', 'utf8')
    const call = vi.fn().mockResolvedValue({
      result: { send: { handle: 'term-1', accepted: true, bytesWritten: 24 } }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['text-file', 'prompt.txt']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd,
      json: true
    })

    expect(call).toHaveBeenCalledWith('terminal.send', {
      terminal: 'term-1',
      text: 'first line\nsegundo café',
      enter: false,
      interrupt: false,
      client: { id: 'orca-cli', type: 'desktop' }
    })
  })

  it('reads text from stdin when --text-file is -', async () => {
    const stdin = mockStdin(['line one\n', 'line two'])
    const call = vi.fn().mockResolvedValue({
      result: { send: { handle: 'term-1', accepted: true, bytesWritten: 17 } }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    try {
      await TERMINAL_HANDLERS['terminal send']({
        flags: new Map<string, string | true>([
          ['terminal', 'term-1'],
          ['text-file', '-']
        ]),
        client: { call } as unknown as RuntimeClient,
        cwd: '/tmp/worktree',
        json: true
      })
    } finally {
      stdin.restore()
    }

    expect(call).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ text: 'line one\nline two' })
    )
  })

  it('rejects --text and --text-file together', async () => {
    const call = vi.fn()

    await expect(
      TERMINAL_HANDLERS['terminal send']({
        flags: new Map<string, string | true>([
          ['terminal', 'term-1'],
          ['text', 'inline'],
          ['text-file', 'prompt.txt']
        ]),
        client: { call } as unknown as RuntimeClient,
        cwd: '/tmp/worktree',
        json: true
      })
    ).rejects.toThrow('--text and --text-file cannot be used together')
    expect(call).not.toHaveBeenCalled()
  })

  it('names a missing text file in the error', async () => {
    const cwd = await createTempDirectory()
    const call = vi.fn()

    await expect(
      TERMINAL_HANDLERS['terminal send']({
        flags: new Map<string, string | true>([
          ['terminal', 'term-1'],
          ['text-file', 'missing-prompt.txt']
        ]),
        client: { call } as unknown as RuntimeClient,
        cwd,
        json: true
      })
    ).rejects.toThrow('missing-prompt.txt')
    expect(call).not.toHaveBeenCalled()
  })

  it('rejects an empty text file with an error naming the path', async () => {
    const cwd = await createTempDirectory()
    await writeFile(join(cwd, 'empty-prompt.txt'), '', 'utf8')
    const call = vi.fn()

    await expect(
      TERMINAL_HANDLERS['terminal send']({
        flags: new Map<string, string | true>([
          ['terminal', 'term-1'],
          ['text-file', 'empty-prompt.txt']
        ]),
        client: { call } as unknown as RuntimeClient,
        cwd,
        json: true
      })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Text file "empty-prompt.txt" is empty.'
    })
    expect(call).not.toHaveBeenCalled()
  })

  it('rejects empty stdin as an empty text file', async () => {
    const stdin = mockStdin([])
    const call = vi.fn()

    try {
      await expect(
        TERMINAL_HANDLERS['terminal send']({
          flags: new Map<string, string | true>([
            ['terminal', 'term-1'],
            ['text-file', '-']
          ]),
          client: { call } as unknown as RuntimeClient,
          cwd: '/tmp/worktree',
          json: true
        })
      ).rejects.toMatchObject({
        code: 'invalid_argument',
        message: 'Text file "-" is empty.'
      })
    } finally {
      stdin.restore()
    }
    expect(call).not.toHaveBeenCalled()
  })

  it('rejects oversized text files before opening a read stream', async () => {
    const cwd = await createTempDirectory()
    const path = join(cwd, 'oversized.txt')
    const handle = await open(path, 'w')
    await handle.truncate(TERMINAL_INPUT_MAX_BYTES + 1)
    await handle.close()
    createReadStreamMock.mockClear()
    const call = vi.fn()

    await expect(
      TERMINAL_HANDLERS['terminal send']({
        flags: new Map<string, string | true>([
          ['terminal', 'term-1'],
          ['text-file', path]
        ]),
        client: { call } as unknown as RuntimeClient,
        cwd,
        json: true
      })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: TERMINAL_INPUT_TOO_LARGE_ERROR
    })
    expect(createReadStreamMock).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
  })

  it('reports oversized stdin with the same JSON error code', async () => {
    const stdin = mockStdin(['x'.repeat(TERMINAL_INPUT_MAX_BYTES), 'x'])
    const call = vi.fn()

    try {
      await expect(
        TERMINAL_HANDLERS['terminal send']({
          flags: new Map<string, string | true>([
            ['terminal', 'term-1'],
            ['text-file', '-']
          ]),
          client: { call } as unknown as RuntimeClient,
          cwd: '/tmp/worktree',
          json: true
        })
      ).rejects.toMatchObject({
        code: 'invalid_argument',
        message: TERMINAL_INPUT_TOO_LARGE_ERROR
      })
    } finally {
      stdin.restore()
    }
    expect(call).not.toHaveBeenCalled()
  })

  it('preserves agent prompt semantics for text-file sends', async () => {
    const cwd = await createTempDirectory()
    await writeFile(join(cwd, 'prompt.txt'), 'review', 'utf8')
    const call = vi.fn().mockResolvedValue({
      result: { send: { handle: 'term-1', accepted: true, bytesWritten: 7 } }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['text-file', 'prompt.txt'],
        ['enter', true]
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd,
      json: true
    })

    expect(call).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ text: 'review', enter: true, interrupt: false, agentPrompt: true })
    )
  })

  it('documents file and stdin terminal input', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    printHelp(COMMAND_SPECS, ['terminal', 'send'])

    const help = String(log.mock.calls[0]?.[0])
    // Why: the usage line is the only budgeted spot in specs/core.ts; it must carry the stdin form.
    expect(help).toContain('--text-file <path|->')
  })
})

function mockStdin(chunks: string[]): { restore: () => void } {
  const stdin = process.stdin
  const previousAsyncIterator = stdin[Symbol.asyncIterator]
  ;(stdin as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = async function* () {
    for (const chunk of chunks) {
      yield Buffer.from(chunk)
    }
  }
  return {
    restore: () => {
      if (previousAsyncIterator) {
        ;(stdin as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = previousAsyncIterator
      } else {
        Reflect.deleteProperty(stdin, Symbol.asyncIterator)
      }
    }
  }
}
