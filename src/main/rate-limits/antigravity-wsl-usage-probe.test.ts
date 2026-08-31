import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { ANTIGRAVITY_WSL_PROBE_SCRIPT } from './antigravity-wsl-usage-probe'

const MAX_RESPONSE_BYTES = 1024 * 1024
const roots: string[] = []

async function createFixture(): Promise<{ root: string; env: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-agy-wsl-probe-'))
  roots.push(root)
  const home = join(root, 'home')
  const logDir = join(home, '.gemini', 'antigravity-cli', 'log')
  const binDir = join(root, 'bin')
  const probeTmp = join(root, 'tmp')
  const procRoot = join(root, 'proc')
  const procDir = join(procRoot, String(process.pid))
  await Promise.all([
    mkdir(logDir, { recursive: true }),
    mkdir(binDir, { recursive: true }),
    mkdir(probeTmp, { recursive: true }),
    mkdir(procDir, { recursive: true })
  ])
  await Promise.all([
    writeFile(join(procDir, 'comm'), 'agy\n'),
    writeFile(join(procDir, 'stat'), `${process.pid} (agy) S${' 0'.repeat(18)} 100 0 0\n`),
    writeFile(join(procRoot, 'stat'), 'btime 0\n')
  ])
  await writeFile(
    join(logDir, 'cli-20260827_000000.log'),
    [
      `Starting language server process with pid ${process.pid}`,
      'random port at 61383 for HTTP'
    ].join('\n')
  )
  const curl = join(binDir, 'curl')
  await writeFile(
    curl,
    String.raw`#!/bin/sh
output=''
headers=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    --dump-header) headers=$2; shift 2 ;;
    --max-filesize) exit 2 ;;
    http://*|https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
[ "$url" = 'http://127.0.0.1:61383/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary' ] || exit 2
[ -z "$headers" ] || printf 'HTTP/1.1 200 OK\r\n\r\n' > "$headers"
if [ "${'$'}{FAKE_CURL_MODE:-body}" = 'connect-fail' ]; then
  exit 7
fi
if [ "${'$'}{FAKE_CURL_MODE:-body}" = 'hang' ]; then
  printf x > "$output"
  printf started > "$FAKE_CURL_STARTED"
  while :; do sleep 1; done
fi
if [ "${'$'}{FAKE_CURL_MODE:-body}" = 'timeout' ]; then
  printf partial > "$output"
  exit 28
fi
head -c "$FAKE_CURL_BYTES" /dev/zero | tr '\000' x > "$output"
[ -n "$headers" ] || printf 200
`
  )
  await chmod(curl, 0o755)
  const getconf = join(binDir, 'getconf')
  await writeFile(getconf, "#!/bin/sh\nprintf '100\\n'\n")
  await chmod(getconf, 0o755)
  const stat = join(binDir, 'stat')
  await writeFile(stat, '#!/bin/sh\nprintf \'%s\\n\' "${FAKE_LOG_MTIME:-2000}"\n')
  await chmod(stat, 0o755)
  return {
    root,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HOME: home,
      TMPDIR: probeTmp,
      ORCA_AGY_PROC_ROOT: procRoot,
      FAKE_LOG_MTIME: '2000',
      FAKE_CURL_STARTED: join(root, 'curl-started')
    }
  }
}

async function runFixture(
  bytes: number,
  mode: 'body' | 'connect-fail' | 'timeout' = 'body',
  signal?: AbortSignal
) {
  const fixture = await createFixture()
  const result = await runProcess({
    program: '/bin/sh',
    args: ['-c', ANTIGRAVITY_WSL_PROBE_SCRIPT],
    env: {
      ...fixture.env,
      FAKE_CURL_BYTES: String(bytes),
      FAKE_CURL_MODE: mode
    },
    timeoutMs: 5_000,
    maxOutputBytes: MAX_RESPONSE_BYTES + 64 * 1024,
    signal
  })
  return { ...fixture, result }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Antigravity WSL probe response boundary', () => {
  it('accepts an old-curl chunked response at exactly 1 MiB and removes its temp files', async () => {
    const { env, result } = await runFixture(MAX_RESPONSE_BYTES)

    expect(result.code).toBe(0)
    expect(result.stdout.startsWith('ORCA_AGY_RESPONSE 200\n')).toBe(true)
    expect(Buffer.byteLength(result.stdout.slice('ORCA_AGY_RESPONSE 200\n'.length))).toBe(
      MAX_RESPONSE_BYTES
    )
    await expect(readdir(env.TMPDIR as string)).resolves.toEqual([])
  })

  it('rejects an old-curl chunked response over 1 MiB at the guest boundary', async () => {
    const { env, result } = await runFixture(MAX_RESPONSE_BYTES * 2)

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('ORCA_AGY_RESPONSE_TOO_LARGE')
    await expect(readdir(env.TMPDIR as string)).resolves.toEqual([])
  })

  it('settles a curl timeout as unverifiable without temp-file residue', async () => {
    const { env, result } = await runFixture(0, 'timeout')

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('ORCA_AGY_UNVERIFIABLE')
    await expect(readdir(env.TMPDIR as string)).resolves.toEqual([])
  })

  it('does not block when curl fails before opening the response pipe', async () => {
    const fixture = await createFixture()
    const result = await runProcess({
      program: '/bin/sh',
      args: ['-c', ANTIGRAVITY_WSL_PROBE_SCRIPT],
      env: { ...fixture.env, FAKE_CURL_BYTES: '0', FAKE_CURL_MODE: 'connect-fail' },
      timeoutMs: 1_000
    })

    expect(result.timedOut).toBe(false)
    expect(result.stdout).toBe('ORCA_AGY_UNVERIFIABLE')
    await expect(readdir(fixture.env.TMPDIR as string)).resolves.toEqual([])
  })

  it('ignores a stale log whose pid belongs to a different process', async () => {
    const fixture = await createFixture()
    await writeFile(
      join(fixture.env.ORCA_AGY_PROC_ROOT as string, String(process.pid), 'comm'),
      'node\n'
    )
    const result = await runProcess({
      program: '/bin/sh',
      args: ['-c', ANTIGRAVITY_WSL_PROBE_SCRIPT],
      env: {
        ...fixture.env,
        FAKE_CURL_BYTES: '0',
        FAKE_CURL_MODE: 'connect-fail'
      },
      timeoutMs: 1_000
    })

    expect(result.timedOut).toBe(false)
    expect(result.stdout).toBe('ORCA_AGY_NOT_RUNNING')
  })

  it('ignores a stale log whose pid was reused by a later Agy process', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.env.ORCA_AGY_PROC_ROOT as string, 'stat'), 'btime 3000\n')
    const result = await runProcess({
      program: '/bin/sh',
      args: ['-c', ANTIGRAVITY_WSL_PROBE_SCRIPT],
      env: {
        ...fixture.env,
        FAKE_CURL_BYTES: '0',
        FAKE_CURL_MODE: 'connect-fail'
      },
      timeoutMs: 1_000
    })

    expect(result.timedOut).toBe(false)
    expect(result.stdout).toBe('ORCA_AGY_NOT_RUNNING')
  })

  it('removes partial response files when the probe is aborted', async () => {
    const fixture = await createFixture()
    const controller = new AbortController()
    const operation = runProcess({
      program: '/bin/sh',
      args: ['-c', ANTIGRAVITY_WSL_PROBE_SCRIPT],
      env: { ...fixture.env, FAKE_CURL_BYTES: '0', FAKE_CURL_MODE: 'hang' },
      timeoutMs: 5_000,
      signal: controller.signal,
      terminationBarrier: true
    })
    await vi.waitFor(async () => {
      await expect(readFile(fixture.env.FAKE_CURL_STARTED as string, 'utf8')).resolves.toBe(
        'started'
      )
    })

    controller.abort(new Error('refresh canceled'))
    await operation

    await expect(readdir(fixture.env.TMPDIR as string)).resolves.toEqual([])
  })

  it('removes partial response files when the host process times out', async () => {
    const fixture = await createFixture()
    const result = await runProcess({
      program: '/bin/sh',
      args: ['-c', ANTIGRAVITY_WSL_PROBE_SCRIPT],
      env: { ...fixture.env, FAKE_CURL_BYTES: '0', FAKE_CURL_MODE: 'hang' },
      timeoutMs: 250,
      terminationBarrier: true
    })

    expect(result.timedOut).toBe(true)
    await expect(readdir(fixture.env.TMPDIR as string)).resolves.toEqual([])
  })
})
