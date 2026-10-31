import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { AUTOMATION_RUN_RESULT_METHODS } from './automation-run-results'
import { buildProfileStateCutoverFixture } from '../../../persistence/profile-state-cutover-fixture'
import { installFakeAppEnvironment } from '../../../../../config/scripts/vitest-host-ports-setup'
import { readAutomationRunOutputFile } from '../../../automations/automation-run-output-files'
import { NOT_IN_AUTOMATION_RUN_MESSAGE } from '../../../automations/automation-run-caller'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-run-report-'))
  installFakeAppEnvironment({ getPath: () => directory })
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

function fixture() {
  const runtime = new OrcaRuntimeService()
  const run = {
    ...buildProfileStateCutoverFixture('/fixture').automationRuns[0],
    status: 'dispatched' as const,
    sessionKind: 'terminal' as const,
    terminalPaneKey: 'tab:leaf',
    terminalPtyId: 'pty'
  }
  vi.spyOn(runtime, 'listAutomationRuns').mockReturnValue([run])
  vi.spyOn(runtime, 'getTerminalHandleForPaneKey').mockReturnValue('handle')
  vi.spyOn(runtime, 'getTerminalPtyIdForHandle').mockReturnValue('pty')
  const record = vi.spyOn(runtime, 'recordAutomationRunReport')
  const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_RUN_RESULT_METHODS })
  const request = {
    id: 'request',
    authToken: 'token',
    method: 'automation.attachOutput',
    params: { title: 'Report', format: 'markdown', content: '# Report' },
    orchestrationCompatibilityEvidence: { terminalHandle: 'handle', paneKey: 'tab:leaf' }
  }
  return { run, record, dispatcher, request }
}

describe('automation output persistence', () => {
  it('keeps accepted content when durable acknowledgement fails', async () => {
    const { run, record, dispatcher, request } = fixture()
    record.mockImplementation(async (_run, report) => {
      if (report.kind === 'output') {
        run.outputs = [report.output]
      }
      throw new Error('disk full')
    })

    expect(await dispatcher.dispatch(request)).toMatchObject({ ok: false })
    const output = run.outputs?.[0]
    expect(output).toBeDefined()
    if (!output) {
      throw new Error('Missing accepted output')
    }
    expect(
      readAutomationRunOutputFile(join(directory, 'automation-run-outputs'), run, output)
    ).toBe('# Report')
  })

  it('removes the file after a known pre-mutation refusal', async () => {
    const { run, record, dispatcher, request } = fixture()
    record.mockResolvedValue({ ok: false, reason: 'output_limit' })

    expect(await dispatcher.dispatch(request)).toMatchObject({ ok: false })
    expect(
      readdirSync(join(directory, 'automation-run-outputs', run.automationId, run.id))
    ).toEqual([])
  })

  it('preserves actionable caller errors in the RPC response', async () => {
    const { dispatcher, request } = fixture()
    expect(
      await dispatcher.dispatch({ ...request, orchestrationCompatibilityEvidence: undefined })
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument', message: NOT_IN_AUTOMATION_RUN_MESSAGE }
    })
  })
})
