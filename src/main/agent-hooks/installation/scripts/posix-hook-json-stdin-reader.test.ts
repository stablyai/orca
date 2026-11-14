// Execute the embedded Python: shape assertions miss chunk-boundary decode failures and cat hangs.
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { buildPosixHookPayloadCapture, POSIX_HOOK_JSON_STDIN } from './hook-stdin-contract'

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
  readonly timedOut: boolean
}

/** Leaving stdin open reproduces Grok SessionStart. */
function runReader(
  chunks: readonly Buffer[],
  { gapMs = 5, closeStdin = false }: { gapMs?: number; closeStdin?: boolean } = {}
): Promise<ReaderRun> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', READER_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = Buffer.alloc(0)
    let timedOut = false
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk])
    })
    child.stderr.resume()
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
})
