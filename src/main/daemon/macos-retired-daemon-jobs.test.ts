import { beforeEach, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import { PROTOCOL_VERSION } from './daemon-protocol-version'
import { macDaemonJobLabel } from './macos-daemon-job-label'

const { run } = vi.hoisted(() => ({ run: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>() }))
vi.mock('@orca/process-host', () => ({ runProcess: run }))
import { listMacDaemonJobVersions, readMacDaemonRecoveryJob } from './macos-retired-daemon-jobs'

const ok: ProcessResult = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
const profile = '/profiles/a'
const runtime = '/profiles/a/daemon'
const version = PROTOCOL_VERSION - 1
const args = [
  '/copy/host',
  '/copy/daemon-entry.js',
  '--socket',
  getDaemonSocketPath(runtime, version),
  '--token',
  getDaemonTokenPath(runtime, version),
  '--pid-record',
  getDaemonPidPath(runtime, version),
  '--launch-nonce',
  'old-nonce',
  '--login-session-watch'
]
const job = (argv = args): string =>
  `service = {\n\tstate = running\n\tpid = 12345\n\targuments = {\n${argv.map((v) => `\t\t${v}\n`).join('')}\t}\n}\n`

beforeEach(() => run.mockReset())

it('discovers only exact same-profile supported labels in one bounded command', async () => {
  run.mockResolvedValue({
    ...ok,
    stdout: [
      `12345\t0\t${macDaemonJobLabel(profile, version)}`,
      `12346\t0\t${macDaemonJobLabel(profile)}`,
      `12347\t0\t${macDaemonJobLabel(profile, PROTOCOL_VERSION + 1)}`,
      `12348\t0\t${macDaemonJobLabel('/profiles/other', version)}`,
      `12349\t0\t${macDaemonJobLabel(profile, version)}.extra`
    ].join('\n')
  })
  expect(await listMacDaemonJobVersions(profile)).toEqual([version, PROTOCOL_VERSION])
  expect(run).toHaveBeenCalledOnce()
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({ args: ['list'], timeoutMs: 3_000, maxOutputBytes: 128 * 1024 })
  )
})

it('requires exact endpoint arguments from the top-level launchd job', async () => {
  run.mockResolvedValue({ ...ok, stdout: job() })
  expect(await readMacDaemonRecoveryJob(profile, runtime, version)).toEqual({
    service: `gui/${process.getuid?.()}/${macDaemonJobLabel(profile, version)}`,
    protocolVersion: version,
    pid: 12345,
    launchNonce: 'old-nonce',
    socketPath: getDaemonSocketPath(runtime, version),
    pidPath: getDaemonPidPath(runtime, version)
  })
})

it.each(
  [
    args.filter((a) => a !== '--login-session-watch'),
    [...args, '--socket', getDaemonSocketPath(runtime, version)],
    args.map((a) => (a === getDaemonSocketPath(runtime, version) ? `${a}.other` : a)),
    args.map((a) => (a === getDaemonTokenPath(runtime, version) ? '/another/token' : a)),
    args.map((a) => (a === getDaemonPidPath(runtime, version) ? '/another/pid' : a)),
    args.filter((a) => a !== 'old-nonce')
  ].map((argv) => ({ argv }))
)('rejects ambiguous or foreign ownership: $argv', async ({ argv }) => {
  run.mockResolvedValue({ ...ok, stdout: job(argv) })
  expect(await readMacDaemonRecoveryJob(profile, runtime, version)).toBeNull()
})

it('ignores a job that exited between list and print', async () => {
  run.mockResolvedValue({ ...ok, code: 113, stderr: 'Could not find service "old"' })
  expect(await readMacDaemonRecoveryJob(profile, runtime, version)).toBeNull()
})

it.each([
  { timedOut: true },
  { outputTruncated: true },
  { code: 1 },
  { code: 113, stderr: 'Could not find service; Permission denied' }
])('fails closed on unreadable or incomplete job output: %j', async (override) => {
  run.mockResolvedValue({ ...ok, stdout: job(), ...override })
  await expect(readMacDaemonRecoveryJob(profile, runtime, version)).rejects.toThrow(
    'Could not inspect'
  )
})

it('never treats a nested state or pid as the running job', async () => {
  run.mockResolvedValue({
    ...ok,
    stdout: job().replace('\tstate = running', '\t\tstate = running')
  })
  expect(await readMacDaemonRecoveryJob(profile, runtime, version)).toBeNull()
})

it('bounds job discovery and rejects an oversized profile inventory', async () => {
  run.mockResolvedValue({
    ...ok,
    stdout: Array.from(
      { length: 33 },
      (_, index) => `12345\t0\t${macDaemonJobLabel(profile, index + 1)}`
    ).join('\n')
  })
  await expect(listMacDaemonJobVersions(profile)).rejects.toThrow('Too many')
  expect(run).toHaveBeenCalledOnce()
})

it('never inspects newer or invalid protocol jobs', async () => {
  for (const unsupported of [0, -1, 1.5, PROTOCOL_VERSION + 1]) {
    expect(await readMacDaemonRecoveryJob(profile, runtime, unsupported)).toBeNull()
  }
  expect(run).not.toHaveBeenCalled()
})
