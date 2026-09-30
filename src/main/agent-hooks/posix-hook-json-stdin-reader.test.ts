// Why an executable suite rather than shape assertions: the reader is a Python
// program embedded in a shell string, so only running it catches a decode that
// raises on a chunk boundary — the shape looked correct while a CJK payload
// crashed the interpreter and fell through to the `cat` hang it exists to avoid.
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  buildPosixHookPayloadCapture,
  POSIX_HOOK_JSON_STDIN,
  POSIX_HOOK_JSON_STDIN_FIRST_BYTE_TIMEOUT_SECONDS,
  POSIX_HOOK_JSON_STDIN_PRELUDE,
  POSIX_HOOK_JSON_STDIN_IDLE_TIMEOUT_SECONDS
} from './hook-stdin-contract'

const execFileAsync = promisify(execFile)

/** The reader plus a line that prints what it captured, so the payload is observable. */
const READER_SCRIPT = [
  ...buildPosixHookPayloadCapture('empty-object', POSIX_HOOK_JSON_STDIN).slice(0, -3),
  'printf %s "$payload"'
].join('\n')

const REPLACEMENT_CHARACTER = '�'
const KILL_AFTER_MS = 9_000

type ReaderRun = {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly timedOut: boolean
}

/** Feeds `chunks` with `gapMs` between them. `closeStdin: false` is the Grok
 *  SessionStart shape: the payload is written and the pipe is left open. */
function runReader(
  chunks: readonly Buffer[],
  {
    gapMs = 5,
    closeStdin = false,
    env
  }: { gapMs?: number; closeStdin?: boolean; env?: NodeJS.ProcessEnv } = {}
): Promise<ReaderRun> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const child = spawn('/bin/sh', ['-c', READER_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env ?? process.env
    })
    let stdout = Buffer.alloc(0)
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk])
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    // A reader that never returns leaves the writer's pipe unread; ignore the tear-down error.
    child.stdin.on('error', () => {})
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, KILL_AFTER_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      resolve({
        exitCode,
        stdout: stdout.toString('utf8'),
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut
      })
    })
    void (async () => {
      for (const chunk of chunks) {
        child.stdin.write(chunk)
        await new Promise((resolveGap) => setTimeout(resolveGap, gapMs))
      }
      if (closeStdin) {
        child.stdin.end()
      }
    })()
  })
}

async function resolveDefaultPathPython(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('/bin/sh', [
      '-c',
      'command -pv python3 || command -pv python'
    ])
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

const hasPython = process.platform === 'win32' ? false : await resolveDefaultPathPython()

describe('POSIX hook JSON stdin reader shape', () => {
  // Why: the Python program is carried in a single-quoted shell assignment, so one
  // apostrophe would end the string and splice the rest of it into the hook as code.
  it('carries no single quote that would escape its shell quoting', () => {
    const prelude = POSIX_HOOK_JSON_STDIN_PRELUDE.join('\n')
    expect(prelude.split("'")).toHaveLength(3)
  })

  it('guards HOME before the interpreter runs', () => {
    expect(POSIX_HOOK_JSON_STDIN.reader.indexOf('unset HOME')).toBeLessThan(
      POSIX_HOOK_JSON_STDIN.reader.indexOf('python3')
    )
  })
})

describe.skipIf(process.platform === 'win32')('POSIX hook JSON stdin reader', () => {
  // Why skipped rather than failed: without an interpreter the chain falls back to
  // `cat`, whose read-to-EOF genuinely cannot return while the writer holds the pipe.
  const itWithPython = it.skipIf(!hasPython)

  itWithPython(
    'keeps a multi-byte character intact when it is split across reads',
    async () => {
      const payload = '{"hook_event_name":"session_start","cwd":"/tmp/漢字","tool":"🚀"}'
      // One byte per write: every multi-byte sequence therefore straddles a read.
      const chunks = [...Buffer.from(`${payload}\n`, 'utf8')].map((byte) => Buffer.from([byte]))

      const result = await runReader(chunks)

      expect(result.timedOut, 'reader returned').toBe(false)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain(REPLACEMENT_CHARACTER)
      expect(result.stdout).toBe(payload)
    },
    KILL_AFTER_MS + 1_000
  )

  // Why: the chain is `python3 || python || cat`, and a reader that died after
  // consuming bytes would hand the next one a truncated stream. A non-zero exit
  // must therefore imply nothing was read.
  itWithPython(
    'never hands a partially consumed stream to the fallback reader',
    async () => {
      const payload = `{"hook_event_name":"session_start","pad":"${'p'.repeat(200_000)}","cwd":"/漢"}`
      const bytes = Buffer.from(`${payload}\n`, 'utf8')
      // Split inside the 3-byte sequence, with a gap long enough that the first
      // read has already completed before the continuation bytes are written.
      const splitAt = bytes.length - 4
      const chunks = [bytes.subarray(0, splitAt), bytes.subarray(splitAt)]

      const result = await runReader(chunks, { gapMs: 400, closeStdin: true })

      expect(result.timedOut, 'reader returned').toBe(false)
      expect(result.exitCode).toBe(0)
      const parsePayload = (): unknown => JSON.parse(result.stdout)
      expect(parsePayload).not.toThrow()
      expect(result.stdout).toBe(payload)
    },
    KILL_AFTER_MS + 1_000
  )

  // Why: re-serialising the object would rewrite non-ASCII as \uXXXX and reorder
  // keys, so the hook server would no longer see what the agent actually sent.
  itWithPython(
    'emits the payload text unchanged rather than re-serialising it',
    async () => {
      const payload = '{"z":"日本語","a":1,"nested":{"b":[1,2]}}'

      const result = await runReader([Buffer.from(`${payload}\n`, 'utf8')])

      expect(result.timedOut, 'reader returned').toBe(false)
      expect(result.stdout).not.toContain('\\u')
      expect(result.stdout).toBe(payload)
    },
    KILL_AFTER_MS + 1_000
  )

  // Why: raw_decode does not skip leading whitespace, so a padded payload would
  // otherwise never complete and would sit out the idle timeout before returning.
  itWithPython(
    'returns immediately for a payload preceded by whitespace',
    async () => {
      const payload = '{"hook_event_name":"session_start"}'

      const result = await runReader([Buffer.from(`\n  ${payload}\n`, 'utf8')])

      expect(result.timedOut, 'reader returned').toBe(false)
      expect(result.stdout).toBe(payload)
      expect(result.durationMs).toBeLessThan(POSIX_HOOK_JSON_STDIN_IDLE_TIMEOUT_SECONDS * 1_000)
    },
    KILL_AFTER_MS + 1_000
  )

  // Why: the first-byte wait is not the idle wait. A host that is slow to schedule
  // the writer must not have its payload silently dropped.
  itWithPython(
    'waits past the idle timeout for a writer that has not sent its first byte',
    async () => {
      const payload = '{"hook_event_name":"session_start"}'

      const result = await runReader([Buffer.alloc(0), Buffer.from(`${payload}\n`)], {
        gapMs: 2_500
      })

      expect(result.timedOut, 'reader returned').toBe(false)
      expect(result.stdout).toBe(payload)
      expect(result.durationMs).toBeLessThan(
        POSIX_HOOK_JSON_STDIN_FIRST_BYTE_TIMEOUT_SECONDS * 1_000
      )
    },
    KILL_AFTER_MS + 1_000
  )

  // Why: not every hook payload is JSON, and the reader replaces `cat` for Grok —
  // it still has to hand back everything a closed stream contained.
  itWithPython(
    'reads a non-JSON payload through to EOF',
    async () => {
      const result = await runReader([Buffer.from('not json at all\nsecond line\n')], {
        closeStdin: true
      })

      expect(result.timedOut, 'reader returned').toBe(false)
      expect(result.stdout).toBe('not json at all\nsecond line')
    },
    KILL_AFTER_MS + 1_000
  )

  // Why: macOS resolves /usr/bin/python3 through an Xcode stub that re-runs its
  // whole tool lookup when it cannot reach a cache under $HOME. A HOME pointing
  // nowhere cost ~6.6s per spawn, which on its own overran Grok's 10s budget.
  itWithPython(
    'stays fast when HOME points at a directory that does not exist',
    async () => {
      const payload = '{"hook_event_name":"session_start"}'

      const result = await runReader([Buffer.from(`${payload}\n`, 'utf8')], {
        env: { ...process.env, HOME: '/nonexistent/orca-hook-home' }
      })

      expect(result.timedOut, 'reader returned').toBe(false)
      expect(result.stdout).toBe(payload)
      expect(result.durationMs).toBeLessThan(2_000)
    },
    KILL_AFTER_MS + 1_000
  )

  itWithPython(
    'reports nothing on stderr on any of these paths',
    async () => {
      const result = await runReader([Buffer.from('{"a":"漢"}\n', 'utf8')])

      expect(result.stderr).toBe('')
    },
    KILL_AFTER_MS + 1_000
  )
})
