import { spawnProcess } from '@orca/process-host'
import { resolveOnDeviceModelHelperPath } from './on-device-model-paths'

/** Failure kinds the helper reports; anything unexpected lands in 'failed'. */
export type OnDeviceModelFailureKind =
  | 'missing'
  | 'unavailable'
  | 'context'
  | 'refusal'
  | 'locale'
  | 'busy'
  | 'timeout'
  | 'canceled'
  | 'failed'

export type OnDeviceModelResult =
  | { ok: true; text: string }
  | { ok: false; kind: OnDeviceModelFailureKind; detail?: string }

export type OnDeviceModelRequest = {
  instructions?: string
  prompt: string
  timeoutMs?: number
  shouldCancel?: () => boolean
}

const DEFAULT_TIMEOUT_MS = 60_000
const CANCEL_POLL_MS = 100

type HelperReply = {
  ok?: boolean
  text?: string
  available?: boolean
  reason?: string
  error?: string
  detail?: string
}

/** One spawn per request: the helper exits on stdin EOF, so no process outlives a generation. */
async function runHelper(
  request: Record<string, unknown>,
  options: { timeoutMs: number; shouldCancel?: () => boolean }
): Promise<HelperReply> {
  const helperPath = resolveOnDeviceModelHelperPath()
  if (!helperPath) {
    throw new MissingHelperError()
  }

  return new Promise<HelperReply>((resolvePromise, rejectPromise) => {
    const child = spawnProcess({ program: helperPath, args: [], stdio: 'pipe' })
    let settled = false
    let stdout = ''
    let stderr = ''

    const finish = (reply: HelperReply | Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      clearInterval(cancelPoll)
      child.stdin.end()
      child.kill()
      if (reply instanceof Error) {
        rejectPromise(reply)
      } else {
        resolvePromise(reply)
      }
    }

    const timer = setTimeout(
      () =>
        finish({ ok: false, error: 'timeout', detail: `no reply after ${options.timeoutMs}ms` }),
      options.timeoutMs
    )
    const cancelPoll = setInterval(() => {
      if (options.shouldCancel?.()) {
        finish({ ok: false, error: 'canceled' })
      }
    }, CANCEL_POLL_MS)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      const newline = stdout.indexOf('\n')
      if (newline === -1) {
        return
      }
      try {
        const parsed: unknown = JSON.parse(stdout.slice(0, newline))
        finish(isHelperReply(parsed) ? parsed : { ok: false, error: 'failed' })
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => finish(error))
    child.on('close', () => {
      // A helper that exits without a reply tells us why only on stderr.
      finish({
        ok: false,
        error: 'failed',
        detail: stderr.trim() || 'helper exited without a reply'
      })
    })

    child.stdin.on('error', () => {
      // A helper that died first surfaces through 'close'.
    })
    child.stdin.write(`${JSON.stringify(request)}\n`)
  })
}

export class MissingHelperError extends Error {
  constructor() {
    super('on-device model helper is not installed')
  }
}

function isHelperReply(value: unknown): value is HelperReply {
  return typeof value === 'object' && value !== null
}

function toResult(reply: HelperReply): OnDeviceModelResult {
  if (reply.available === false) {
    return { ok: false, kind: 'unavailable', detail: reply.reason }
  }
  if (reply.ok && typeof reply.text === 'string') {
    return { ok: true, text: reply.text }
  }
  return { ok: false, kind: failureKind(reply.error), detail: reply.detail }
}

function failureKind(error: string | undefined): OnDeviceModelFailureKind {
  switch (error) {
    case undefined:
      return 'failed'
    case 'context':
    case 'refusal':
    case 'locale':
    case 'busy':
    case 'unavailable':
    case 'timeout':
    case 'canceled':
      return error
    default:
      return 'failed'
  }
}

export type OnDeviceModelAvailability =
  | { available: true }
  | { available: false; kind: OnDeviceModelFailureKind; detail?: string }

export async function probeOnDeviceModel(): Promise<OnDeviceModelAvailability> {
  try {
    const reply = await runHelper({ id: 'probe', op: 'probe' }, { timeoutMs: 10_000 })
    return reply.available === true
      ? { available: true }
      : { available: false, kind: failureKind(reply.error), detail: reply.reason ?? reply.detail }
  } catch (error) {
    return {
      available: false,
      kind: error instanceof MissingHelperError ? 'missing' : 'failed',
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function generateOnDeviceText(
  request: OnDeviceModelRequest
): Promise<OnDeviceModelResult> {
  try {
    return toResult(
      await runHelper(
        {
          id: 'generate',
          op: 'generate',
          instructions: request.instructions ?? '',
          prompt: request.prompt
        },
        { timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS, shouldCancel: request.shouldCancel }
      )
    )
  } catch (error) {
    return {
      ok: false,
      kind: error instanceof MissingHelperError ? 'missing' : 'failed',
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}
