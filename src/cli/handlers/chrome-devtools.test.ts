import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { CHROME_DEVTOOLS_HANDLERS } from './chrome-devtools'
import {
  callChromeDevtoolsTool,
  listChromeDevtoolsTools
} from '../../main/agent-mcp/chrome-devtools-bridge'

vi.mock('../../main/agent-mcp/chrome-devtools-bridge', () => ({
  callChromeDevtoolsTool: vi.fn(),
  listChromeDevtoolsTools: vi.fn()
}))
vi.mock('../../main/agent-mcp/chrome-devtools-session', () => ({
  runChromeDevtoolsSession: vi.fn()
}))
vi.mock('../format', () => ({ printResult: vi.fn() }))
let directory: string
let previousExitCode: typeof process.exitCode
function context(entries: [string, string | boolean][] = []): HandlerContext {
  return {
    cwd: directory,
    json: true,
    flags: new Map(entries),
    get client(): never {
      throw new Error('Must not create an RPC client')
    }
  }
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-chrome-bridge-test-'))
  previousExitCode = process.exitCode
  vi.clearAllMocks()
  for (const key of ['ORCA_CLI_CWD', 'ORCA_ENVIRONMENT', 'ORCA_PAIRING_CODE']) {
    vi.stubEnv(key, '')
  }
  vi.mocked(callChromeDevtoolsTool).mockResolvedValue({ content: [] })
  vi.mocked(listChromeDevtoolsTools).mockResolvedValue({ tools: [] })
})
afterEach(async () => {
  process.exitCode = previousExitCode
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})
describe('Chrome DevTools CLI bridge', () => {
  it.each(['tools', 'call', 'session'])(
    'rejects remote flags before %s starts any MCP process',
    async (command) => {
      for (const flag of ['host', 'environment', 'pairing-code']) {
        await expect(
          CHROME_DEVTOOLS_HANDLERS[`chrome-devtools ${command}`](context([[flag, 'remote']]))
        ).rejects.toThrow()
      }
      expect(callChromeDevtoolsTool).not.toHaveBeenCalled()
      expect(listChromeDevtoolsTools).not.toHaveBeenCalled()
    }
  )
  it.each(['ORCA_CLI_CWD', 'ORCA_ENVIRONMENT', 'ORCA_PAIRING_CODE'])(
    'rejects forwarded context %s',
    async (key) => {
      vi.stubEnv(key, 'remote')
      await expect(CHROME_DEVTOOLS_HANDLERS['chrome-devtools tools'](context())).rejects.toThrow(
        'direct local invocation'
      )
      expect(listChromeDevtoolsTools).not.toHaveBeenCalled()
    }
  )
  it('lists schemas without creating an RPC client', async () => {
    await CHROME_DEVTOOLS_HANDLERS['chrome-devtools tools'](context())
    expect(listChromeDevtoolsTools).toHaveBeenCalledOnce()
  })
  it('passes JSON file arguments unchanged including shell metacharacters', async () => {
    const args = { expression: '"quotes"; $(ignored)', nested: { value: true } }
    await writeFile(join(directory, 'arguments with spaces.json'), JSON.stringify(args))
    await CHROME_DEVTOOLS_HANDLERS['chrome-devtools call'](
      context([
        ['tool', 'evaluate_script'],
        ['arguments-file', 'arguments with spaces.json']
      ])
    )
    expect(callChromeDevtoolsTool).toHaveBeenCalledWith('evaluate_script', args)
  })
  it('uses empty arguments when the optional file is absent', async () => {
    await CHROME_DEVTOOLS_HANDLERS['chrome-devtools call'](context([['tool', 'list_pages']]))
    expect(callChromeDevtoolsTool).toHaveBeenCalledWith('list_pages', {})
  })
  it.each(['[]', 'null', 'invalid'])(
    'rejects invalid argument contents %s before starting MCP',
    async (contents) => {
      await writeFile(join(directory, 'arguments.json'), contents)
      await expect(
        CHROME_DEVTOOLS_HANDLERS['chrome-devtools call'](
          context([
            ['tool', 'example'],
            ['arguments-file', 'arguments.json']
          ])
        )
      ).rejects.toThrow()
      expect(callChromeDevtoolsTool).not.toHaveBeenCalled()
    }
  )
  it('requires a tool name and a value for a supplied arguments-file flag', async () => {
    await expect(CHROME_DEVTOOLS_HANDLERS['chrome-devtools call'](context())).rejects.toThrow(
      'Provide --tool'
    )
    await expect(
      CHROME_DEVTOOLS_HANDLERS['chrome-devtools call'](
        context([
          ['tool', 'list_pages'],
          ['arguments-file', true]
        ])
      )
    ).rejects.toThrow('Provide a path')
  })
  it('prints the full MCP error result and sets a failing exit code', async () => {
    const result = {
      isError: true,
      content: [{ type: 'text' as const, text: 'Permission denied' }]
    }
    vi.mocked(callChromeDevtoolsTool).mockResolvedValue(result)
    await CHROME_DEVTOOLS_HANDLERS['chrome-devtools call'](context([['tool', 'list_pages']]))
    expect(printResult).toHaveBeenCalledWith(
      expect.objectContaining({ result }),
      true,
      expect.any(Function)
    )
    expect(process.exitCode).toBe(1)
  })
})
