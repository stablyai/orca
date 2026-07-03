import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
agent_dir="\${PI_CODING_AGENT_DIR:-\${ORCA_FAKE_OMP_DEFAULT_DIR:-}}"
if [ "\${1:-}" = "config" ] && [ -n "$agent_dir" ]; then
  mkdir -p "$agent_dir"
  printf 'updated-by-omp-config\\n' > "$agent_dir/config.yml"
fi
{
  printf 'PI=%s\\n' "$PI_CODING_AGENT_DIR"
  printf 'EFFECTIVE=%s\\n' "$agent_dir"
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
      PI_CODING_AGENT_DIR: '',
      ORCA_PI_CODING_AGENT_DIR: '',
      ORCA_OMP_CODING_AGENT_DIR: '',
      ORCA_OMP_STATUS_EXTENSION: statusExtension,
      ORCA_FAKE_OMP_DEFAULT_DIR: ompDir,
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
    expect(unwrapped).toContain('PI=\n')
    expect(unwrapped).toContain(`EFFECTIVE=${ompDir}`)
    expect(unwrapped).toContain('ARG1=ask')
    expect(unwrapped).not.toContain('ARG1=--extension')

    const wrappedCapture = join(tempDir, 'wrapped-capture')
    const wrappedAfterPi = join(tempDir, 'wrapped-after-pi')
    const wrappedOutput = await runInteractiveBashPty({
      cwd: tempDir,
      rcfileContent: getPosixOmpShellWrapper(),
      env: makeEnv(wrappedCapture, wrappedAfterPi),
      input: `type omp
omp ask
printf '%s' "$PI_CODING_AGENT_DIR" > "$ORCA_AFTER_PI_FILE"
exit 0
`
    })

    const wrapped = readFileSync(wrappedCapture, 'utf8')
    expect(wrappedOutput).toContain('omp is a function')
    expect(wrapped).toContain('PI=\n')
    expect(wrapped).toContain(`EFFECTIVE=${ompDir}`)
    expect(wrapped).toContain('ARG1=--extension')
    expect(wrapped).toContain(`ARG2=${statusExtension}`)
    expect(wrapped).toContain('ARG3=ask')
    expect(readFileSync(wrappedAfterPi, 'utf8')).toBe('')
  })

  itWithBash('runs OMP config subcommands without redirecting the home', async () => {
    const tempDir = makeTempDir()
    const binDir = join(tempDir, 'bin')
    const sourceDir = join(tempDir, 'source-omp-agent')
    const extensionDir = join(sourceDir, 'extensions')
    mkdirSync(binDir)
    mkdirSync(sourceDir, { recursive: true })
    mkdirSync(extensionDir, { recursive: true })
    const statusExtension = join(extensionDir, 'orca-agent-status.ts')
    writeFileSync(statusExtension, 'export default {}')
    writeFakeOmp(binDir)

    const captureFile = join(tempDir, 'config-capture')
    await runInteractiveBashPty({
      cwd: tempDir,
      rcfileContent: getPosixOmpShellWrapper(),
      env: {
        ...process.env,
        HOME: tempDir,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        PI_CODING_AGENT_DIR: '',
        ORCA_PI_CODING_AGENT_DIR: '',
        ORCA_OMP_CODING_AGENT_DIR: '',
        ORCA_OMP_SOURCE_AGENT_DIR: sourceDir,
        ORCA_OMP_STATUS_EXTENSION: statusExtension,
        ORCA_FAKE_OMP_DEFAULT_DIR: sourceDir,
        ORCA_CAPTURE_FILE: captureFile,
        TERM: process.env.TERM || 'xterm-256color'
      },
      input: `omp config
exit 0
`
    })

    const capture = readFileSync(captureFile, 'utf8')
    expect(capture).toContain('PI=\n')
    expect(capture).toContain(`EFFECTIVE=${sourceDir}`)
    expect(capture).toContain('ARG1=config')
    expect(readFileSync(join(sourceDir, 'config.yml'), 'utf8')).toBe('updated-by-omp-config\n')
  })

  itWithBash.each([
    '__complete',
    'bench',
    'completions',
    'dry-balance',
    'gallery',
    'install',
    'join',
    'models',
    'say',
    'tiny-models',
    'token',
    'ttsr',
    'usage'
  ])('runs OMP %s subcommands without injecting the status extension', async (subcommand) => {
    const tempDir = makeTempDir()
    const binDir = join(tempDir, 'bin')
    const sourceDir = join(tempDir, 'source-omp-agent')
    const extensionDir = join(sourceDir, 'extensions')
    mkdirSync(binDir)
    mkdirSync(sourceDir, { recursive: true })
    mkdirSync(extensionDir, { recursive: true })
    const statusExtension = join(extensionDir, 'orca-agent-status.ts')
    writeFileSync(statusExtension, 'export default {}')
    writeFakeOmp(binDir)

    const captureFile = join(tempDir, `${subcommand}-capture`)
    await runInteractiveBashPty({
      cwd: tempDir,
      rcfileContent: getPosixOmpShellWrapper(),
      env: {
        ...process.env,
        HOME: tempDir,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        PI_CODING_AGENT_DIR: '',
        ORCA_PI_CODING_AGENT_DIR: '',
        ORCA_OMP_CODING_AGENT_DIR: '',
        ORCA_OMP_SOURCE_AGENT_DIR: sourceDir,
        ORCA_OMP_STATUS_EXTENSION: statusExtension,
        ORCA_FAKE_OMP_DEFAULT_DIR: sourceDir,
        ORCA_CAPTURE_FILE: captureFile,
        TERM: process.env.TERM || 'xterm-256color'
      },
      input: `omp ${subcommand}
exit 0
`
    })

    const capture = readFileSync(captureFile, 'utf8')
    expect(capture).toContain('PI=\n')
    expect(capture).toContain(`EFFECTIVE=${sourceDir}`)
    expect(capture).toContain(`ARG1=${subcommand}`)
    expect(capture).not.toContain('ARG1=--extension')
  })

  itWithBash(
    'lets OMP config subcommands fall back to the default home without a source shadow',
    async () => {
      const tempDir = makeTempDir()
      const binDir = join(tempDir, 'bin')
      const defaultOmpDir = join(tempDir, '.omp', 'agent')
      const extensionDir = join(defaultOmpDir, 'extensions')
      mkdirSync(binDir)
      mkdirSync(defaultOmpDir, { recursive: true })
      mkdirSync(extensionDir, { recursive: true })
      const statusExtension = join(extensionDir, 'orca-agent-status.ts')
      writeFileSync(statusExtension, 'export default {}')
      writeFakeOmp(binDir)

      const captureFile = join(tempDir, 'default-config-capture')
      await runInteractiveBashPty({
        cwd: tempDir,
        rcfileContent: getPosixOmpShellWrapper(),
        env: {
          ...process.env,
          HOME: tempDir,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          PI_CODING_AGENT_DIR: '',
          ORCA_PI_CODING_AGENT_DIR: '',
          ORCA_OMP_CODING_AGENT_DIR: '',
          ORCA_OMP_STATUS_EXTENSION: statusExtension,
          ORCA_FAKE_OMP_DEFAULT_DIR: defaultOmpDir,
          ORCA_CAPTURE_FILE: captureFile,
          TERM: process.env.TERM || 'xterm-256color'
        },
        input: `omp config
exit 0
`
      })

      const capture = readFileSync(captureFile, 'utf8')
      expect(capture).toContain('PI=\n')
      expect(capture).toContain(`EFFECTIVE=${defaultOmpDir}`)
      expect(readFileSync(join(defaultOmpDir, 'config.yml'), 'utf8')).toBe(
        'updated-by-omp-config\n'
      )
    }
  )
})
