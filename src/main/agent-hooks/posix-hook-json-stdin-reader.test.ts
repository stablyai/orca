// Execute the embedded Python: shape assertions miss chunk-boundary decode failures and cat hangs.
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  buildPosixHookPayloadCapture,
  POSIX_HOOK_JSON_STDIN,
  POSIX_HOOK_JSON_STDIN_FIRST_BYTE_TIMEOUT_SECONDS,
  POSIX_HOOK_JSON_STDIN_IDLE_TIMEOUT_SECONDS
} from './hook-stdin-contract'

const execFileAsync = promisify(execFile)

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

/** Leaving stdin open reproduces Grok SessionStart. */
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

describe.skipIf(process.platform === 'win32')('POSIX hook JSON stdin reader', () => {
  // Without Python the fallback cat cannot finish while the writer keeps stdin open.
  const itWithPython = it.skipIf(!hasPython)

  it('clears invalid HOME for the interpreter and preserves the caller environment', async () => {
    for (const homeDir of ['/nonexistent/orca-hook-home', tmpdir()]) {
      const { stdout } = await execFileAsync(
        '/bin/sh',
        [
          '-c',
          [
            'command() { printf "%s" "${HOME-unset}"; }',
            READER_SCRIPT,
            'printf "\\n%s" "$HOME"'
          ].join('\n')
        ],
        { env: { ...process.env, HOME: homeDir } }
      )
      expect(stdout).toBe(`${homeDir === tmpdir() ? homeDir : 'unset'}\n${homeDir}`)
    }
  })

  itWithPython(
    'keeps a multi-byte character intact when it is split across reads',
    async () => {
      const payload = '{"hook_event_name":"session_start","cwd":"/tmp/漢字","tool":"🚀"}'
      // One-byte writes exercise split UTF-8 sequences.
      const chunks = [...Buffer.from(`${payload}\n`, 'utf8')].map((byte) => Buffer.from([byte]))

      const result = await runReader(chunks)

      expect(result.timedOut, 'reader returned').toBe(false)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain(REPLACEMENT_CHARACTER)
      expect(result.stdout).toBe(payload)
    },
    KILL_AFTER_MS + 1_000
  )

  // Fallback readers need the entire stream; a nonzero exit must mean no bytes were consumed.
  itWithPython(
    'never hands a partially consumed stream to the fallback reader',
    async () => {
      const payload = `{"hook_event_name":"session_start","pad":"${'p'.repeat(200_000)}","cwd":"/漢"}`
      const bytes = Buffer.from(`${payload}\n`, 'utf8')
      // Delay continuation bytes so the first read ends inside a three-byte UTF-8 sequence.
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

  // Scheduling delay before the first byte must not count as an idle payload.
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

  // An invalid HOME can stall the macOS Xcode Python stub beyond the hook budget.
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

      expect(result.timedOut, 'reader returned').toBe(false)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('{"a":"漢"}')
      expect(result.stderr).toBe('')
    },
    KILL_AFTER_MS + 1_000
  )
})
