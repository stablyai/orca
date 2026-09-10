import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeEnvironment = vi.fn()
const getSshFilesystemProvider = vi.fn()
const executeOfficeMethod = vi.fn()

vi.mock('../ipc/runtime-environment-transport-routing', () => ({ callRuntimeEnvironment }))
vi.mock('../persistence', () => ({ getCanonicalUserDataPath: () => '/userdata' }))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({ getSshFilesystemProvider }))
vi.mock('./office-method-executor', () => ({ executeOfficeMethod }))

const { dispatchOfficeRequest, renderOfficeOnHost } = await import('./office-host-dispatch')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('office host dispatch', () => {
  it('runs local work in this process', async () => {
    executeOfficeMethod.mockResolvedValue({ ok: true, html: '<p/>', kind: 'word' })
    await dispatchOfficeRequest({ kind: 'local' }, 'office.render', { path: '/w/a.docx' })
    expect(executeOfficeMethod).toHaveBeenCalledWith('office.render', { path: '/w/a.docx' })
  })

  it('never falls back to this machine when an SSH host is unreachable', async () => {
    // Loss of contact is `unverifiable`, and rendering here would use the wrong machine's
    // officecli and fonts. See docs/reference/ssh-execution-boundary.md.
    getSshFilesystemProvider.mockReturnValue(null)
    const outcome = await dispatchOfficeRequest(
      { kind: 'ssh', connectionId: 'box' },
      'office.probe',
      {}
    )
    expect(outcome).toEqual({ ok: false, code: 'OFFICE_HOST_UNREACHABLE' })
    expect(executeOfficeMethod).not.toHaveBeenCalled()
  })

  it('forwards SSH work to the relay through the provider', async () => {
    const officeRequest = vi.fn().mockResolvedValue({ ok: true, marks: [] })
    getSshFilesystemProvider.mockReturnValue({ officeRequest })
    await dispatchOfficeRequest({ kind: 'ssh', connectionId: 'box' }, 'office.marks', {
      path: '/w/a.pptx'
    })
    expect(officeRequest).toHaveBeenCalledWith('office.marks', { path: '/w/a.pptx' })
  })

  it('tells the reader to update a paired host that has no office methods', async () => {
    // Fail closed on an old host: the raw method_not_found wording reads as a broken preview
    // rather than an out-of-date machine.
    callRuntimeEnvironment.mockResolvedValue({
      ok: false,
      error: { code: 'method_not_found', message: 'unknown method' }
    })
    const outcome = await dispatchOfficeRequest(
      { kind: 'runtime', environmentId: 'env' },
      'office.render',
      {
        path: '/w/a.docx'
      }
    )
    expect(outcome).toEqual({ ok: false, code: 'OFFICE_HOST_UPDATE_REQUIRED' })
  })

  it('reports an unreachable paired host without claiming anything about the work', async () => {
    callRuntimeEnvironment.mockRejectedValue(new Error('socket closed'))
    const outcome = await dispatchOfficeRequest(
      { kind: 'runtime', environmentId: 'env' },
      'office.probe',
      {}
    )
    expect(outcome).toEqual({ ok: false, code: 'OFFICE_HOST_UNREACHABLE', detail: 'socket closed' })
  })

  it('refuses a render answer that carries no document', async () => {
    executeOfficeMethod.mockResolvedValue({ ok: true, marks: [] })
    const outcome = await renderOfficeOnHost(
      { kind: 'local' },
      { workspaceRoot: '/w', relativePath: 'a.docx' }
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.code).toBe('OFFICECLI_RENDER_FAILED')
  })
})
