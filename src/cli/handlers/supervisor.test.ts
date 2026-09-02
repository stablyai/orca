import { hostname } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { printServiceMock, runDoctorMock, collectDoctorFindingsMock } = vi.hoisted(() => ({
  printServiceMock: vi.fn(),
  runDoctorMock: vi.fn(),
  collectDoctorFindingsMock: vi.fn()
}))

// Why mock: these handlers are an adapter, and the thing worth pinning is the argv they
// build and the exit code they carry — not the generator, which has its own tests and
// would drag a real host's service files into this one.
vi.mock('../../main/orcad/orcad-service-command', () => ({
  printService: printServiceMock,
  runDoctor: runDoctorMock,
  collectDoctorFindings: collectDoctorFindingsMock
}))

import { SUPERVISOR_HANDLERS } from './supervisor'
import { SupervisorServiceUnsupportedError } from '../../shared/supervisor-service-render'

const originalExitCode = process.exitCode
let stdout: string

beforeEach(() => {
  stdout = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk)
    return true
  })
})

afterEach(() => {
  process.exitCode = originalExitCode
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

function run(
  command: string,
  flags: [string, string | boolean][] = [],
  json = false
): Promise<void> {
  return SUPERVISOR_HANDLERS[command]({ flags: new Map(flags), json } as never)
}

it('rebuilds the argv the orcad parser expects, in its own flag order', async () => {
  printServiceMock.mockResolvedValue(0)

  await run('supervisor print', [
    ['bind', '127.0.0.1'],
    ['scope', 'system'],
    ['orcad', '/opt/orcad/orcad.js'],
    ['user', 'orca']
  ])

  expect(printServiceMock).toHaveBeenCalledWith([
    '--orcad',
    '/opt/orcad/orcad.js',
    '--scope',
    'system',
    '--user',
    'orca',
    '--bind',
    '127.0.0.1'
  ])
})

// Why: the orcad parser reads --no-probe as a bare switch and treats the next token as an
// unknown argument, so emitting it with a value would fail the command outright.
it('emits a boolean flag bare and omits the flags nobody passed', async () => {
  runDoctorMock.mockResolvedValue(0)

  await run('supervisor doctor', [
    ['service-path', '/etc/systemd/system/orcad.service'],
    ['no-probe', true]
  ])

  expect(runDoctorMock).toHaveBeenCalledWith([
    '--service-path',
    '/etc/systemd/system/orcad.service',
    '--no-probe'
  ])
})

it('refuses --json on print instead of generating a unit file wrapped in nothing', async () => {
  await expect(
    run('supervisor print', [['orcad', '/opt/orcad/orcad.js']], true)
  ).rejects.toMatchObject({ code: 'invalid_argument' })

  expect(printServiceMock).not.toHaveBeenCalled()
})

it('carries the audit exit code out of the JSON path and names the host it read', async () => {
  const findings = [{ code: 'kill_mode_unsafe', severity: 'critical', message: 'KillMode=mixed' }]
  collectDoctorFindingsMock.mockResolvedValue({ findings, code: 1 })

  await run('supervisor doctor', [], true)

  expect(JSON.parse(stdout)).toEqual({ host: hostname(), findings })
  expect(process.exitCode).toBe(1)
})

// Why the host is on stdout at all: the CLI normally targets a paired remote runtime, so a
// verdict that does not name a machine reads as one about the machine you meant.
it('names the host in the text path and leaves a clean audit exit code alone', async () => {
  runDoctorMock.mockResolvedValue(0)

  await run('supervisor doctor')

  expect(stdout).toContain(`on ${hostname()} (this machine)`)
  expect(process.exitCode).toBe(originalExitCode)
})

it('reports an unsupported platform as a bad request rather than a CLI crash', async () => {
  printServiceMock.mockRejectedValue(new SupervisorServiceUnsupportedError('win32'))

  await expect(run('supervisor print', [['orcad', '/opt/orcad/orcad.js']])).rejects.toMatchObject({
    code: 'invalid_argument'
  })
})

// Why: the missing-`--orcad` refusal is a plain Error raised inside the generator, and its
// message is the only thing that names the flag — translating it would lose that.
it('leaves every other failure with its own message', async () => {
  printServiceMock.mockRejectedValue(
    new Error('this process is /opt/orca/cli/index.js, not orcad.js')
  )

  await expect(run('supervisor print')).rejects.toThrow('not orcad.js')
})
