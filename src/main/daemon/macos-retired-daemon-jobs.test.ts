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
