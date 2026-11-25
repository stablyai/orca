import { afterEach, describe, expect, it, vi } from 'vitest'
import { cliErrorExitCode } from '../output/cli-exit-code'
import { reportCliError } from '../output/cli-error'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime/connection/types'
import { PLUGIN_INSTALL_HANDLERS } from './plugin-install'

const UPDATED = {
  status: 'updated',
  pluginKey: 'acme.good',
  version: '1.1.0',
  previousVersion: '1.0.0',
  approval: 'kept',
  source: {
    kind: 'git',
    official: false,
    publisher: 'acme',
    repository: 'github.com/acme/good',
    url: 'https://github.com/acme/good.git',
    ref: 'v1.1.0',
    commit: 'd'.repeat(40),
    path: null,
    catalog: null
  }
}
const UP_TO_DATE = {
  status: 'up-to-date',
  pluginKey: 'acme.same',
  version: '2.0.0',
  reason: 'No version newer than 2.0.0.'
}
const PINNED = { status: 'pinned', pluginKey: 'acme.pin', version: '3.0.0', reason: 'Pinned.' }
const FAILED = { pluginKey: 'acme.bad', code: 'git_auth_failed', message: 'auth\ndetail' }

function updateAll(call: () => Promise<unknown>) {
  return PLUGIN_INSTALL_HANDLERS['plugin update']({
    flags: new Map([['all', true]]),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: update --all uses only client.call, supplied here.
    client: { call } as never,
    cwd: '/',
    json: false,
    rawArgs: ['plugin', 'update', '--all']
  }).then(
    () => null,
    (failure: unknown) => failure
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('orca plugin update --all', () => {
  it('fails with every outcome row and the failed plugins when an update failed', async () => {
    const result = { updates: [UPDATED, UP_TO_DATE, PINNED], approvals: [], failed: [FAILED] }
    const error = await updateAll(async () => ({ result }))

    expect(error).toBeInstanceOf(RuntimeClientError)
    if (!(error instanceof RuntimeClientError)) {
      return
    }
    expect(cliErrorExitCode(error, ['plugin', 'update'])).toBe(1)
    expect(error.message).toContain('Updated acme.good 1.1.0 (was 1.0.0)')
    expect(error.message).toContain('Source: github.com/acme/good (v1.1.0)')
    expect(error.message).toContain('acme.same 2.0.0 is up-to-date: No version newer than 2.0.0.')
    expect(error.message).toContain('acme.pin 3.0.0 is pinned: Pinned.')
    expect(error.message).toContain('1 plugin update(s) failed:\n- acme.bad: auth\n  detail')

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    reportCliError(error, true, { commandPath: ['plugin', 'update'] })
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'plugin_install_failed',
        data: {
          updates: result.updates,
          failed: [FAILED],
          nextSteps: ['To retry acme.bad and see how to fix it, run: orca plugin update acme.bad']
        }
      }
    })
  })

  it('lists failed plugins under the approval request, failure step first', async () => {
    const approvals = [{ pluginKey: 'acme.wants', approvalFingerprint: 'ap1-x' }]
    const error = await updateAll(async () => {
      throw new RuntimeRpcFailureError({
        id: '1',
        ok: false,
        error: {
          code: 'approval_required',
          message: '1 plugin update(s) need approval before they install:',
          data: {
            updates: [UPDATED],
            approvals,
            failed: [FAILED],
            nextSteps: ['Confirm with your user first.', 'To approve acme.wants, run: host form']
          }
        },
        _meta: { runtimeId: 'runtime' }
      })
    })

    expect(error).toBeInstanceOf(RuntimeClientError)
    if (!(error instanceof RuntimeClientError)) {
      return
    }
    expect(cliErrorExitCode(error, ['plugin', 'update'])).toBe(3)
    expect(error.message).toContain('1 plugin update(s) failed:\n- acme.bad: auth\n  detail')
    expect(error.data).toMatchObject({
      approvals,
      failed: [FAILED],
      nextSteps: [
        'To retry acme.bad and see how to fix it, run: orca plugin update acme.bad',
        'Confirm with your user first.',
        'To approve acme.wants, run: orca plugin update acme.wants --approve ap1-x'
      ]
    })
  })

  it('names the installed source and the requested source apart when the record kept its source', async () => {
    const kept = {
      ...UPDATED,
      source: {
        ...UPDATED.source,
        repository: 'github.com/other/good',
        url: 'https://github.com/other/good.git',
        commit: 'e'.repeat(40)
      },
      requestedSource: {
        ...UPDATED.source,
        repository: 'github.com/acme/good',
        url: 'https://github.com/acme/good.git',
        commit: 'd'.repeat(40)
      }
    }
    const result = { updates: [kept], approvals: [], failed: [] }
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    expect(await updateAll(async () => ({ result }))).toBeNull()
    const output = String(write.mock.calls[0]?.[0])
    expect(output).toContain(`Source: github.com/other/good (v1.1.0) at commit ${'e'.repeat(12)}.`)
    expect(output).toContain(
      `Requested from github.com/acme/good (v1.1.0) at commit ${'d'.repeat(12)}. Its files match the installed copy, so the installed source above was kept.`
    )
    expect(output).not.toContain(`Source: github.com/acme/good`)
  })

  it('prints every row when nothing failed', async () => {
    const result = { updates: [UPDATED, PINNED], approvals: [], failed: [] }
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    expect(await updateAll(async () => ({ result }))).toBeNull()
    expect(String(write.mock.calls[0]?.[0])).toContain('acme.pin 3.0.0 is pinned: Pinned.')
  })
})
