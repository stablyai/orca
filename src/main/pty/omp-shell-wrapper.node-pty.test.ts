import { spawnSync } from 'child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as pty from 'node-pty'
import { afterEach, describe, expect, it } from 'vitest'
import { getPosixOmpShellWrapper } from './omp-shell-wrapper'

const describePosix = process.platform === 'win32' ? describe.skip : describe
const hasBash = process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0
const itWithBash = hasBash ? it : it.skip

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-omp-node-pty-'))
  tempDirs.push(dir)
  return dir
}

function writeFakeOmp(binDir: string): void {
  const ompPath = join(binDir, 'omp')
  writeFileSync(
    ompPath,
    `#!/bin/sh
{
  printf 'PI=%s\\n' "$PI_CODING_AGENT_DIR"
  i=0
  for arg in "$@"; do
    i=$((i + 1))
    printf 'ARG%s=%s\\n' "$i" "$arg"
  done
} > "$ORCA_CAPTURE_FILE"
`,
    { mode: 0o755 }
  )
  chmodSync(ompPath, 0o755)
}

async function runInteractiveBashPty(args: {
  rcfileContent: string
  env: Record<string, string>
  input: string
  cwd: string
}): Promise<string> {
  const rcfile = join(args.cwd, 'rcfile')
  writeFileSync(rcfile, args.rcfileContent)

  const proc = pty.spawn('bash', ['--noprofile', '--rcfile', rcfile, '-i'], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: args.cwd,
    env: args.env
  })

  let output = ''
  proc.onData((data) => {
    output += data
  })

  const exitPromise = new Promise<{ exitCode: number }>((resolve) => {
    proc.onExit(({ exitCode }) => resolve({ exitCode }))
  })

  let timeout: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`timed out waiting for bash PTY output:\n${output}`)),
      5000
    )
  })

  try {
    proc.write(args.input.replace(/\n/g, '\r'))
    const { exitCode } = await Promise.race([exitPromise, timeoutPromise])
    expect(exitCode).toBe(0)
    return output
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout)
    }
    try {
      proc.kill()
    } catch {
      // The process may already have exited normally before cleanup runs.
    }
  }
}

describePosix('OMP shell wrapper node-pty reproduction', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  itWithBash('reproduces why restored shells miss OMP status without the wrapper', async () => {
    const tempDir = makeTempDir()
    const binDir = join(tempDir, 'bin')
    const piDir = join(tempDir, 'pi-agent')
    const ompDir = join(tempDir, 'omp-agent')
    const extensionDir = join(ompDir, 'extensions')
    mkdirSync(binDir)
    mkdirSync(piDir)
    mkdirSync(extensionDir, { recursive: true })
    const statusExtension = join(extensionDir, 'orca-agent-status.ts')
    writeFileSync(statusExtension, 'export default {}')
    writeFakeOmp(binDir)

    const makeEnv = (captureFile: string, afterPiFile: string): Record<string, string> => ({
      ...process.env,
      HOME: tempDir,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      PI_CODING_AGENT_DIR: piDir,
      ORCA_PI_CODING_AGENT_DIR: piDir,
      ORCA_OMP_CODING_AGENT_DIR: ompDir,
      ORCA_OMP_STATUS_EXTENSION: statusExtension,
      ORCA_CAPTURE_FILE: captureFile,
      ORCA_AFTER_PI_FILE: afterPiFile,
      TERM: process.env.TERM || 'xterm-256color'
    })

    const unwrappedCapture = join(tempDir, 'unwrapped-capture')
    const unwrappedAfterPi = join(tempDir, 'unwrapped-after-pi')
    await runInteractiveBashPty({
      cwd: tempDir,
      rcfileContent: '',
      env: makeEnv(unwrappedCapture, unwrappedAfterPi),
      input: `omp ask
printf '%s' "$PI_CODING_AGENT_DIR" > "$ORCA_AFTER_PI_FILE"
exit 0
`
    })

    const unwrapped = readFileSync(unwrappedCapture, 'utf8')
    expect(unwrapped).toContain(`PI=${piDir}`)
    expect(unwrapped).toContain('ARG1=ask')
    expect(unwrapped).not.toContain('ARG1=--extension')

    const wrappedCapture = join(tempDir, 'wrapped-capture')
    const wrappedAfterPi = join(tempDir, 'wrapped-after-pi')
    const wrappedOutput = await runInteractiveBashPty({
      cwd: tempDir,
      rcfileContent: `[[ -n "\${ORCA_PI_CODING_AGENT_DIR:-}" ]] && export PI_CODING_AGENT_DIR="\${ORCA_PI_CODING_AGENT_DIR}"
${getPosixOmpShellWrapper()}`,
      env: makeEnv(wrappedCapture, wrappedAfterPi),
      input: `type omp
omp ask
printf '%s' "$PI_CODING_AGENT_DIR" > "$ORCA_AFTER_PI_FILE"
exit 0
`
    })

    const wrapped = readFileSync(wrappedCapture, 'utf8')
    expect(wrappedOutput).toContain('omp is a function')
    expect(wrapped).toContain(`PI=${ompDir}`)
    expect(wrapped).toContain('ARG1=--extension')
    expect(wrapped).toContain(`ARG2=${statusExtension}`)
    expect(wrapped).toContain('ARG3=ask')
    expect(readFileSync(wrappedAfterPi, 'utf8')).toBe(piDir)
  })
})
