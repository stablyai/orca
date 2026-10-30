/** Delete the emulator map entry before disposal so new writes create a fresh emulator.
 * Chain disposal after all queued parses; reversing either order silently loses output. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { HeadlessEmulator } from '../daemon/headless-emulator'

const store = {
  getRepo: () => undefined,
  getRepos: () => [],
  addRepo: () => {},
  updateRepo: () => undefined as never,
  getAllWorktreeMeta: () => ({}),
  getWorktreeMeta: () => undefined,
  setWorktreeMeta: () => undefined as never,
  removeWorktreeMeta: () => {},
  getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
  addRetiredWorktreeName: () => {},
  mergeRetiredWorktreeNames: () => false,
  getGitHubCache: () => ({ pr: {}, issue: {} }) as never,
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: '',
    terminalMainSideEffectAuthority: true
  })
}

const PTY_ID = 'pty-dispose-ordering'

function createRuntime(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => ({ cols: 80, rows: 24 }),
    resize: () => true
  })
  return runtime
}

describe('disposeHeadlessTerminal write ordering', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses a write queued before disposal, then routes later writes to a fresh emulator', async () => {
    const events: string[] = []
    const emulators: HeadlessEmulator[] = []
    const write = HeadlessEmulator.prototype.write
    const dispose = HeadlessEmulator.prototype.dispose
    vi.spyOn(HeadlessEmulator.prototype, 'write').mockImplementation(async function (
      this: HeadlessEmulator,
      data: string,
      opts
    ) {
      if (!emulators.includes(this)) {
        emulators.push(this)
      }
      events.push(`write:${emulators.indexOf(this)}:${data.trim()}`)
      return write.call(this, data, opts)
    })
    vi.spyOn(HeadlessEmulator.prototype, 'dispose').mockImplementation(function (
      this: HeadlessEmulator
    ) {
      events.push(`dispose:${emulators.indexOf(this)}`)
      return dispose.call(this)
    })

    const runtime = createRuntime()
    runtime.onPtyData(PTY_ID, 'QUEUED-BEFORE-DISPOSE\r\n', 1)
    runtime.preparePtyExecutionContext(PTY_ID, null, { resetIncarnation: true })
    runtime.onPtyData(PTY_ID, 'ISSUED-AFTER-DISPOSE\r\n', 2)
    await runtime.serializeHiddenOutputRecoveryBuffer(PTY_ID)

    expect(events).toEqual([
      'write:0:QUEUED-BEFORE-DISPOSE',
      'write:1:ISSUED-AFTER-DISPOSE',
      'dispose:0'
    ])
  })

  it('leaves the post-disposal emulator holding only post-disposal output', async () => {
    const runtime = createRuntime()
    runtime.onPtyData(PTY_ID, 'QUEUED-BEFORE-DISPOSE\r\n', 1)
    runtime.preparePtyExecutionContext(PTY_ID, null, { resetIncarnation: true })
    runtime.onPtyData(PTY_ID, 'ISSUED-AFTER-DISPOSE\r\n', 2)

    const snapshot = await runtime.serializeHiddenOutputRecoveryBuffer(PTY_ID)
    const painted = `${snapshot?.scrollbackAnsi ?? ''}${snapshot?.data ?? ''}`
    expect(painted).toContain('ISSUED-AFTER-DISPOSE')
    expect(painted).not.toContain('QUEUED-BEFORE-DISPOSE')
  })
})
