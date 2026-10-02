import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { CliStatusResult, RuntimeTerminalSend } from '../../shared/runtime-types'
import { TERMINAL_INPUT_MAX_BYTES } from '../../shared/terminal-input'
import { parseArgs, validateCommandAndFlags } from '../args'
import { printHelp } from '../help'
import { RuntimeClient, type RuntimeRpcSuccess } from '../runtime-client'
import { COMMAND_SPECS } from '../specs'
import { terminalSendHandler } from './terminal-send'

const stdin = process.stdin
const ttyDescriptor = Object.getOwnPropertyDescriptor(stdin, 'isTTY')
const originalExitCode = process.exitCode
const retryId = '11111111-1111-4111-8111-111111111111'
const literalText = '"quoted" \'single\' `literal` $HOME $(literal)\r\n/compact é 😀\n'
let source: Readable

function sendResponse(prompt = true): RuntimeRpcSuccess<{ send: RuntimeTerminalSend }> {
  return {
    id: 'send-1',
    ok: true,
    result: {
      send: {
        handle: 'term-1',
        accepted: true,
        bytesWritten: 1,
        ...(prompt
          ? {
              prompt: {
                requestId: retryId,
                stages: ['input_accepted'] as const,
                provider: 'codex' as const,
                observation: 'supported' as const,
                processIncarnation: 'inc-1',
                generation: 1,
                baselineWorkingSequence: 0
              }
            }
          : {})
      }
    },
    _meta: { runtimeId: 'runtime-1' }
  }
}

function statusResponse(supported: boolean, reachable = true): RuntimeRpcSuccess<CliStatusResult> {
  return {
    id: 'status-1',
    ok: true,
    result: {
      app: { running: true, pid: process.pid },
      runtime: {
        state: 'ready',
        reachable,
        runtimeId: 'runtime-1',
        capabilities: supported ? [TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY] : []
      },
      graph: { state: 'ready' }
    },
    _meta: { runtimeId: 'runtime-1' }
  }
}

function createClient(supported = true) {
  const client = new RuntimeClient(
    join(process.cwd(), '.issue-sweep', 'unit-no-runtime'),
    500,
    null,
    null
  )
  const call = vi.spyOn(client, 'call').mockResolvedValue(sendResponse())
  const status = vi.spyOn(client, 'getCliStatus').mockResolvedValue(statusResponse(supported))
  return { client, call, status }
}

async function send(client: RuntimeClient, ...args: string[]) {
  const parsed = parseArgs(['terminal', 'send', ...args], undefined, COMMAND_SPECS)
  validateCommandAndFlags(COMMAND_SPECS, parsed)
  await terminalSendHandler({ flags: parsed.flags, client, cwd: process.cwd(), json: true })
}

beforeEach(() => {
  source = Readable.from([])
  Object.defineProperty(stdin, 'isTTY', { configurable: true, value: false })
  vi.spyOn(stdin, Symbol.asyncIterator).mockImplementation(() => source[Symbol.asyncIterator]())
  vi.spyOn(console, 'log').mockImplementation(() => {})
  process.exitCode = undefined
})

afterEach(() => {
  source.destroy()
  vi.restoreAllMocks()
  if (ttyDescriptor) {
    Object.defineProperty(stdin, 'isTTY', ttyDescriptor)
  } else {
    Reflect.deleteProperty(stdin, 'isTTY')
  }
  process.exitCode = originalExitCode
})

describe('terminal send stdin discovery and acquisition', () => {
  it('registers the stdin boolean flag once and describes its command usage', () => {
    const specs = COMMAND_SPECS.filter((spec) => spec.path.join(' ') === 'terminal send')
    expect(specs).toHaveLength(1)
    const parsed = parseArgs(['terminal', 'send', '--text-stdin'], undefined, COMMAND_SPECS)
    expect(parsed.flags.get('text-stdin')).toBe(true)
    expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed)).not.toThrow()
    printHelp(COMMAND_SPECS, ['terminal', 'send'])
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('--text <text> | --text-stdin')
    )
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('EOF'))
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('1 MiB'))
  })

  it('passes syntax, line endings, trailing newline and split UTF-8 to the existing RPC once', async () => {
    const { client, call, status } = createClient()
    source = Readable.from(Array.from(Buffer.from(literalText), (byte) => Buffer.from([byte])))
    await send(client, '--terminal', 'term-1', '--text-stdin')
    expect(call).toHaveBeenCalledExactlyOnceWith('terminal.send', {
      terminal: 'term-1',
      text: literalText,
      enter: false,
      interrupt: false,
      client: { id: 'orca-cli', type: 'desktop' }
    })
    expect(status).not.toHaveBeenCalled()
  })

  it.each(['hello', ''])(
    'refuses both sources, including explicit empty argv (%s), before reading or resolving',
    async (text) => {
      const { client, call, status } = createClient()
      await expect(send(client, `--text=${text}`, '--text-stdin')).rejects.toMatchObject({
        code: 'invalid_argument',
        message: 'Use either --text or --text-stdin, not both'
      })
      expect(stdin[Symbol.asyncIterator]).not.toHaveBeenCalled()
      expect(call).not.toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    }
  )

  it('refuses interactive stdin without a terminal lookup or send', async () => {
    const { client, call, status } = createClient()
    Object.defineProperty(stdin, 'isTTY', { configurable: true, value: true })
    await expect(send(client, '--text-stdin')).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('TTY')
    })
    expect(stdin[Symbol.asyncIterator]).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
    expect(status).not.toHaveBeenCalled()
  })

  it('refuses a failed read before terminal lookup or send', async () => {
    const { client, call, status } = createClient()
    const pipe = new PassThrough()
    source = pipe
    const error = new Error('owned stdin failure')
    const pending = send(client, '--text-stdin')
    pipe.destroy(error)
    await expect(pending).rejects.toBe(error)
    expect(call).not.toHaveBeenCalled()
    expect(status).not.toHaveBeenCalled()
  })

  it('rejects one raw byte over the terminal budget with zero runtime calls', async () => {
    const { client, call, status } = createClient()
    source = Readable.from([Buffer.alloc(TERMINAL_INPUT_MAX_BYTES, 'x'), Buffer.from('y')])
    await expect(send(client, '--text-stdin', '--enter')).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(call).not.toHaveBeenCalled()
    expect(status).not.toHaveBeenCalled()
  })

  it('accepts the exact terminal budget without truncation in the handler fixture', async () => {
    const { client, call } = createClient()
    const text = `${'x'.repeat(TERMINAL_INPUT_MAX_BYTES - 2)}é`
    source = Readable.from([Buffer.from(text)])
    await send(client, '--terminal', 'term-1', '--text-stdin')
    expect(call).toHaveBeenCalledExactlyOnceWith('terminal.send', expect.objectContaining({ text }))
  })

  it.each([[], ['--enter']])('allows empty stdin as direct input (%j)', async (...suffix) => {
    const { client, call, status } = createClient()
    await send(client, '--terminal', 'term-1', '--text-stdin', ...suffix)
    expect(call).toHaveBeenCalledExactlyOnceWith('terminal.send', {
      terminal: 'term-1',
      text: '',
      enter: suffix.length > 0,
      interrupt: false,
      client: { id: 'orca-cli', type: 'desktop' }
    })
    expect(status).not.toHaveBeenCalled()
  })

  it.each([
    ['--wait-submit', '1'],
    ['--retry-request', retryId]
  ])('refuses empty stdin with %s', async (flag, value) => {
    const { client, call, status } = createClient()
    await expect(send(client, '--text-stdin', '--enter', flag, value)).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('nonempty --text or --text-stdin')
    })
    expect(call).not.toHaveBeenCalled()
    expect(status).not.toHaveBeenCalled()
  })

  it.each([
    ['--wait-submit', '0', '--enter'],
    ['--wait-submit', '-1', '--enter'],
    ['--wait-submit', '1.5', '--enter'],
    ['--wait-submit', '3601', '--enter'],
    ['--wait-submit', '--enter'],
    ['--retry-request='],
    ['--retry-request'],
    ['--retry-request', 'not-a-uuid', '--enter'],
    ['--wait-submit', '1'],
    ['--retry-request', retryId, '--enter', '--interrupt']
  ])(
    'validates invalid ranges and structural conflicts before reading stdin (%j)',
    async (...args) => {
      const { client, call, status } = createClient()
      await expect(send(client, '--text-stdin', ...args)).rejects.toMatchObject({
        code: 'invalid_argument'
      })
      expect(stdin[Symbol.asyncIterator]).not.toHaveBeenCalled()
      expect(call).not.toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    }
  )

  it.each([['--text', literalText], ['--enter'], []])(
    'keeps existing argv and no-text actions without reading stdin (%j)',
    async (...args) => {
      const { client, call, status } = createClient()
      await send(client, '--terminal', 'term-1', ...args)
      expect(call).toHaveBeenCalledExactlyOnceWith('terminal.send', {
        terminal: 'term-1',
        text: args[0] === '--text' ? literalText : undefined,
        enter: args[0] === '--enter',
        interrupt: false,
        client: { id: 'orca-cli', type: 'desktop' }
      })
      expect(stdin[Symbol.asyncIterator]).not.toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    }
  )
})

describe('terminal stdin prompt delivery parity', () => {
  it('uses identical preflight, retry identity, wait and receipt behavior for stdin and argv', async () => {
    const { client, call, status } = createClient()
    const args = [
      '--terminal',
      'term-1',
      '--enter',
      '--wait-submit',
      '3',
      '--retry-request',
      retryId
    ]
    await send(client, '--text', literalText, ...args)
    const argvCall = call.mock.calls[0]
    const argvOutput = vi.mocked(console.log).mock.calls[0]
    source = Readable.from([Buffer.from(literalText)])
    await send(client, '--text-stdin', ...args)
    source = Readable.from([Buffer.from(literalText)])
    await send(client, '--text-stdin', ...args)
    expect(call).toHaveBeenCalledTimes(3)
    expect(call.mock.calls[1]).toEqual(argvCall)
    expect(call.mock.calls[2]).toEqual(argvCall)
    expect(argvCall).toEqual([
      'terminal.send',
      {
        terminal: 'term-1',
        text: literalText,
        enter: true,
        interrupt: false,
        agentPrompt: true,
        waitSubmitMs: 3000,
        client: { id: 'orca-cli', type: 'desktop' }
      },
      {
        terminalPromptPreflight: { runtimeId: 'runtime-1' },
        orchestrationRequestId: retryId,
        timeoutMs: 13000
      }
    ])
    expect(status).toHaveBeenCalledTimes(3)
    expect(vi.mocked(console.log).mock.calls[1]).toEqual(argvOutput)
    expect(String(argvOutput?.[0])).toContain('no turn start was observed')
  })

  it.each([
    ['--wait-submit', '1'],
    ['--retry-request', retryId]
  ])('refuses unsupported-host %s before sending', async (flag, value) => {
    const { client, call } = createClient(false)
    source = Readable.from([Buffer.from(literalText)])
    await expect(send(client, '--text-stdin', '--enter', flag, value)).rejects.toMatchObject({
      code: 'incompatible_runtime'
    })
    expect(call).not.toHaveBeenCalled()
  })

  it('keeps the ordinary old-host legacy send and warning', async () => {
    const { client, call } = createClient(false)
    call.mockResolvedValue(sendResponse(false))
    source = Readable.from([Buffer.from(literalText)])
    await send(client, '--terminal', 'term-1', '--text-stdin', '--enter')
    expect(call).toHaveBeenCalledExactlyOnceWith(
      'terminal.send',
      expect.objectContaining({ text: literalText, agentPrompt: true }),
      { legacyTerminalPrompt: true }
    )
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('old-host'))
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('warnings'))
  })

  it('keeps unknown-delivery recovery when a modern host accepts without the required receipt', async () => {
    const { client, call } = createClient()
    call.mockResolvedValue(sendResponse(false))
    source = Readable.from([Buffer.from(literalText)])
    await expect(
      send(client, '--terminal', 'term-1', '--text-stdin', '--enter')
    ).rejects.toMatchObject({
      code: 'incompatible_runtime',
      data: { deliveryOutcome: 'unknown', retrySafe: false },
      message: expect.stringContaining('do not resend automatically')
    })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('refuses an unreachable preflight without sending', async () => {
    const { client, call, status } = createClient()
    status.mockResolvedValue(statusResponse(true, false))
    source = Readable.from([Buffer.from(literalText)])
    await expect(send(client, '--text-stdin', '--enter')).rejects.toMatchObject({
      code: 'runtime_unavailable'
    })
    expect(call).not.toHaveBeenCalled()
  })

  it('keeps interrupt outside the prompt-candidate path', async () => {
    const { client, call, status } = createClient()
    source = Readable.from([Buffer.from(literalText)])
    await send(client, '--terminal', 'term-1', '--text-stdin', '--enter', '--interrupt')
    expect(call).toHaveBeenCalledExactlyOnceWith('terminal.send', {
      terminal: 'term-1',
      text: literalText,
      enter: true,
      interrupt: true,
      client: { id: 'orca-cli', type: 'desktop' }
    })
    expect(status).not.toHaveBeenCalled()
  })

  it('preserves a refused send receipt and exit code 1', async () => {
    const { client, call } = createClient()
    const response = sendResponse(false)
    response.result.send.accepted = false
    response.result.send.bytesWritten = 0
    call.mockResolvedValue(response)
    source = Readable.from([Buffer.from(literalText)])
    await send(client, '--terminal', 'term-1', '--text-stdin', '--enter')
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"accepted": false'))
    expect(process.exitCode).toBe(1)
    expect(call).toHaveBeenCalledTimes(1)
  })
})
