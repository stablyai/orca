import { expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { fenceOutgoingPtyRegistrations } from './outgoing-pty-registration-fence'

class Runtime extends OrcaRuntimeService {
  retainHandle(incarnationId: string | null) {
    this.registerPty('pty', 'folder:source')
    const pty = this.ptysById.get('pty')!
    pty.incarnationId = incarnationId
    this.handleByPtyIncarnation.set(pty.ptyId, {
      handle: 'term_retained',
      incarnationId,
      leafKey: 'tab::leaf'
    })
    return () => this.issuePtyHandle(pty)
  }
}

it.each([null, 'incarnation'])('retains the same handle for incarnation %s', (incarnationId) => {
  const issue = new Runtime().retainHandle(incarnationId)
  expect(issue()).toBe('term_retained')
  expect(issue()).toBe('term_retained')
})

it.each([null, 'incarnation'])(
  'checks outgoing ownership before returning retained incarnation %s',
  (incarnationId) => {
    const runtime = new Runtime()
    const issue = runtime.retainHandle(incarnationId)
    fenceOutgoingPtyRegistrations(runtime, ['pty'])
    expect(issue).toThrow('orcad_outgoing_source_registration_fenced')
  }
)
