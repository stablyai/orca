import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))
vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock(mocks)
})
vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: mocks.addEnvironmentFromPairingCodeMock,
  listEnvironments: mocks.listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))
vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(mocks.spawnMock)
})

import { main } from './index'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'
import { okFixture, queueFixtures } from './test-fixtures'
import { RuntimeRpcFailureError } from './runtime/types'
import { AUTOMATION_RUN_RESULTS_RUNTIME_CAPABILITY } from '../shared/automation-runtime-capabilities'
import { MAX_AUTOMATION_RUN_OUTPUT_BYTES } from '../shared/automation-run-results'
import { AutomationRunOutputAttach } from '../shared/rpc-contract/automation-params'

const directory = mkdtempSync(join(tmpdir(), 'orca-cli-report-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const NOT_IN_AUTOMATION_RUN_MESSAGE =
  'Not running inside an Orca automation run on this host. Run this command from the automation agent.'
const originalExitCode = process.exitCode
afterEach(() => {
  process.exitCode = originalExitCode
})

function supported() {
  queueFixtures(
    mocks.callMock,
    okFixture('status', { capabilities: [AUTOMATION_RUN_RESULTS_RUNTIME_CAPABILITY] }),
    okFixture('attached', { runId: 'run', outputId: 'output' })
  )
}

describe('automation run result CLI', () => {
  useWorktreeAwarenessEnvironment(mocks)
  afterEach(() => rmSync(join(directory, 'weekly-brief.md'), { force: true }))

  it('rejects escape-heavy reports before transport and uses the same RPC budget', async () => {
    const content = '\\'.repeat(MAX_AUTOMATION_RUN_OUTPUT_BYTES)
    writeFileSync(join(directory, 'weekly-brief.md'), content)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['automations', 'attach', '--file', 'weekly-brief.md'], directory)

    expect(mocks.callMock).not.toHaveBeenCalled()
    expect(error.mock.calls.flat().join(' ')).toContain('Shorten the report')
    expect(
      AutomationRunOutputAttach.safeParse({ title: 'Report', format: 'markdown', content }).success
    ).toBe(false)
  })

  it.each([undefined, 'Custom title'])(
    'defaults the title to the basename and permits override %s',
    async (title) => {
      writeFileSync(join(directory, 'weekly-brief.md'), '# Report')
      supported()
      vi.spyOn(console, 'log').mockImplementation(() => {})
      await main(
        [
          'automations',
          'attach',
          '--file',
          'weekly-brief.md',
          ...(title ? ['--title', title] : [])
        ],
        directory
      )

      expect(mocks.callMock).toHaveBeenLastCalledWith('automation.attachOutput', {
        title: title ?? 'weekly-brief',
        format: 'markdown',
        content: '# Report'
      })
    }
  )

  it('prints the actionable invalid-argument message returned by the host', async () => {
    mocks.callMock
      .mockResolvedValueOnce(
        okFixture('status', { capabilities: [AUTOMATION_RUN_RESULTS_RUNTIME_CAPABILITY] })
      )
      .mockRejectedValueOnce(
        new RuntimeRpcFailureError({
          id: 'report',
          ok: false,
          error: { code: 'invalid_argument', message: NOT_IN_AUTOMATION_RUN_MESSAGE },
          _meta: { runtimeId: 'runtime' }
        })
      )
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await main(['automations', 'fail', '--message', 'Failed'], directory)
    expect(error.mock.calls.flat().join(' ')).toContain(NOT_IN_AUTOMATION_RUN_MESSAGE)
  })

  it('shows resolution without a required message', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['automations', 'warn', '--help'], directory)
    expect(log.mock.calls.flat().join(' ')).toContain(
      'warn --key <id> --resolve [--message <text>]'
    )
  })
})
