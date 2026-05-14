import { spawn } from 'child_process'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { dirname } from 'path'
import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import { resolveAuthorizedPath } from './filesystem-auth'

export type NotebookRunResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  error?: string
}

const PYTHON_RUN_TIMEOUT_MS = 60_000
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024

type BoundedCapture = {
  text: string
  bytes: number
  truncated: boolean
}

function pythonCandidates(): { command: string; argsPrefix: string[] }[] {
  const configured = process.env.ORCA_NOTEBOOK_PYTHON?.trim()
  const candidates: { command: string; argsPrefix: string[] }[] = []
  if (configured) {
    candidates.push({ command: configured, argsPrefix: [] })
  }
  if (process.platform === 'win32') {
    candidates.push({ command: 'py', argsPrefix: ['-3'] })
  }
  candidates.push({ command: 'python3', argsPrefix: [] }, { command: 'python', argsPrefix: [] })
  return candidates
}

function appendBounded(capture: BoundedCapture, chunk: Buffer): void {
  if (capture.truncated) {
    return
  }
  const remainingBytes = MAX_CAPTURE_BYTES - capture.bytes
  if (remainingBytes <= 0) {
    capture.truncated = true
    return
  }
  if (chunk.byteLength <= remainingBytes) {
    capture.text += chunk.toString('utf8')
    capture.bytes += chunk.byteLength
    return
  }
  capture.text += `${chunk.subarray(0, remainingBytes).toString('utf8')}\n[output truncated]\n`
  capture.bytes = MAX_CAPTURE_BYTES
  capture.truncated = true
}

function terminateNotebookProcessTree(
  child: ChildProcessWithoutNullStreams
): ReturnType<typeof setTimeout> | null {
  if (!child.pid) {
    child.kill()
    return null
  }

  if (process.platform === 'win32') {
    try {
      // Why: a timed-out cell can spawn descendants. taskkill /T is the
      // Windows equivalent of terminating the whole process group.
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      })
      killer.on('error', () => child.kill())
      killer.unref()
    } catch {
      child.kill()
    }
    return null
  }

  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill()
  }

  const forceKillTimer = setTimeout(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      /* process group already exited */
    }
  }, 2000)
  forceKillTimer.unref?.()
  return forceKillTimer
}

function buildPythonExecutionCode(code: string, preamble: string): string {
  const payload = Buffer.from(JSON.stringify({ code, preamble }), 'utf8').toString('base64')
  return [
    'import base64, contextlib, io, json, sys, traceback',
    `payload = json.loads(base64.b64decode(${JSON.stringify(payload)}).decode("utf-8"))`,
    'namespace = {"__name__": "__main__"}',
    'try:',
    '    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):',
    '        exec(payload["preamble"], namespace)',
    '    exec(payload["code"], namespace)',
    'except Exception:',
    '    traceback.print_exc()',
    '    sys.exit(1)'
  ].join('\n')
}

async function runPythonCandidate(
  candidate: { command: string; argsPrefix: string[] },
  code: string,
  preamble: string,
  cwd: string
): Promise<NotebookRunResult> {
  return new Promise((resolve) => {
    const stdout: BoundedCapture = { text: '', bytes: 0, truncated: false }
    const stderr: BoundedCapture = { text: '', bytes: 0, truncated: false }
    let settled = false
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null
    const child = spawn(
      candidate.command,
      [...candidate.argsPrefix, '-c', buildPythonExecutionCode(code, preamble)],
      {
        cwd,
        detached: process.platform !== 'win32',
        windowsHide: true,
        env: process.env
      }
    )
    const timeout = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      forceKillTimer = terminateNotebookProcessTree(child)
      resolve({
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode: null,
        error: 'Python cell timed out.'
      })
    }, PYTHON_RUN_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => {
      appendBounded(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      appendBounded(stderr, chunk)
    })
    child.on('error', (error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
      }
      resolve({ stdout: stdout.text, stderr: stderr.text, exitCode: null, error: error.message })
    })
    child.on('close', (exitCode) => {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
      }
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve({ stdout: stdout.text, stderr: stderr.text, exitCode })
    })
  })
}

async function runPythonCell(
  code: string,
  preamble: string,
  cwd: string
): Promise<NotebookRunResult> {
  if (!code.trim() && !preamble.trim()) {
    return { stdout: '', stderr: '', exitCode: 0 }
  }

  let lastError = 'Python was not found.'
  for (const candidate of pythonCandidates()) {
    const result = await runPythonCandidate(candidate, code, preamble, cwd)
    if (!result.error?.includes('ENOENT')) {
      return result
    }
    lastError = result.error
  }
  return { stdout: '', stderr: '', exitCode: null, error: lastError }
}

export function registerNotebookHandlers(store: Store): void {
  ipcMain.handle(
    'notebook:runPythonCell',
    async (
      _event,
      args: { filePath: string; code: string; preamble?: string; connectionId?: string | null }
    ): Promise<NotebookRunResult> => {
      if (args.connectionId) {
        return {
          stdout: '',
          stderr: '',
          exitCode: null,
          error: 'Notebook execution is currently supported for local files only.'
        }
      }
      const filePath = await resolveAuthorizedPath(args.filePath, store)
      // Why: execute relative to the notebook file so local imports and data
      // paths behave the same way users expect from a notebook opened on disk.
      return runPythonCell(args.code, args.preamble ?? '', dirname(filePath))
    }
  )
}
