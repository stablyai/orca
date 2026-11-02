import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionOwnerBinding } from '../../../../shared/agent-session/agent-session-host-authority'
import {
  completeSavedRestoreFresh,
  decideSavedRestore,
  mintSavedRestoreReceipt,
  settleSavedRestoreLaunch
} from './saved-restore-receipt'

const seam = vi.hoisted(() => ({
  seed: vi.fn(),
  forget: vi.fn(),
  probe: vi.fn(),
  release: vi.fn(),
  adopted: null as null | ((owner: AgentSessionOwnerBinding) => void)
}))
vi.mock('../../../agent-hooks/server', () => ({
  agentHookServer: { launchSeedSince: seam.seed, forgetRefusedPaneResume: seam.forget }
}))
vi.mock('./store-presence', () => ({ probeSavedResumeStore: seam.probe }))
vi.mock('../pane/agent-session-owner-release', () => ({
  releaseAgentSessionOwnerForFresh: seam.release,
  onAgentSessionOwnerAdopted: (listener: typeof seam.adopted) => {
    seam.adopted = listener
    return () => {}
  }
}))

const SEED = { paneKey: 'tab-1:leaf', receivedAt: 10, stateStartedAt: 10 }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the receipt compares only ptyId and generation.
const OWNER = { ptyId: 'pty-1', generation: 'g3' } as AgentSessionOwnerBinding
let next = 0

function armed({ owner }: { owner?: AgentSessionOwnerBinding } = { owner: OWNER }) {
  const token = (next += 1).toString(16).padStart(32, '0')
  mintSavedRestoreReceipt(token, {
    paneKey: 'tab-1:leaf',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'X' },
    resumeArgs: ['--resume', 'X'],
    worktreeId: 'wt-1',
    admission: {
      verdict: 'admitted',
      refused: { agent: 'claude', providerSession: { key: 'session_id', id: 'X' } }
    },
    settings: undefined
  })
  const launch = () =>
    settleSavedRestoreLaunch(token, {
      ptyId: 'pty-1',
      incarnationId: 'inc-1',
      owner,
      launchToken: 'launch-1'
    })
  const check = (args = ['--resume', 'X'], remainingMs = 4_000) =>
    decideSavedRestore({
      token,
      agent: 'claude',
      args,
      roots: { HOME: '/home/u' },
      cwd: '/repo',
      remainingMs
    })
  const runtime = {
    releaseAgentSessionResumeHold: vi.fn(),
    forgetRefusedSavedResume: vi.fn(async () => {}),
    publishTerminalSavedRestoreFresh: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: completion reads only these members.
  const dispatched = () => completeSavedRestoreFresh(token, runtime as never)
  return { launch, check, dispatched, runtime }
}

beforeEach(() => {
  seam.seed.mockReset().mockReturnValue(SEED)
  seam.forget.mockReset()
  seam.probe.mockReset().mockResolvedValue('missing')
  seam.release.mockReset().mockResolvedValue(true)
})

describe("main's one decision for a generated restore line", () => {
  it('releases the old owner before answering fresh, and forgets and shows only after dispatch', async () => {
    const restore = armed()
    restore.launch()
    await expect(restore.check()).resolves.toBe('fresh')
    expect(seam.release).toHaveBeenCalledWith(expect.objectContaining({ owner: OWNER }))
    expect(seam.forget).not.toHaveBeenCalled()
    restore.dispatched()
    restore.dispatched()
    expect(seam.forget).toHaveBeenCalledOnce()
    expect(seam.forget).toHaveBeenCalledWith(
      'tab-1:leaf',
      expect.objectContaining({ expectedStatus: SEED })
    )
    expect(restore.runtime.releaseAgentSessionResumeHold).toHaveBeenCalledOnce()
    expect(restore.runtime.publishTerminalSavedRestoreFresh).toHaveBeenCalledOnce()
    expect(restore.runtime.publishTerminalSavedRestoreFresh).toHaveBeenCalledWith({
      paneKey: 'tab-1:leaf',
      ptyId: 'pty-1',
      incarnationId: 'inc-1',
      launchToken: 'launch-1',
      dispatchId: expect.any(String)
    })
  })

  it.each<[string, () => void]>([
    [
      'the release is refused (an old daemon, a failure or a mismatch)',
      () => seam.release.mockResolvedValue(false)
    ],
    ['the store has it or cannot say', () => seam.probe.mockResolvedValue('unknown')],
    ['a hook reported since the launch', () => seam.seed.mockReturnValue(null)]
  ])('resumes when %s', async (_label, arrange) => {
    arrange()
    const restore = armed()
    restore.launch()
    await expect(restore.check()).resolves.toBe('resume')
    restore.dispatched()
    expect(seam.forget).not.toHaveBeenCalled()
    expect(restore.runtime.publishTerminalSavedRestoreFresh).not.toHaveBeenCalled()
  })

  it('resumes a changed command, a replayed proof, or a launch that never published', async () => {
    let restore = armed()
    restore.launch()
    await expect(restore.check(['--resume', 'X', '--model', 'y'])).resolves.toBe('resume')
    await expect(restore.check()).resolves.toBe('resume')
    restore = armed()
    settleSavedRestoreLaunch(next.toString(16).padStart(32, '0'), null)
    await expect(restore.check()).resolves.toBe('resume')
    restore = armed()
    await expect(restore.check(undefined, 400)).resolves.toBe('resume')
    expect(seam.probe).not.toHaveBeenCalled()
  })

  it('keeps the conversation for an explicit open that adopted the owner while the check ran', async () => {
    const restore = armed()
    restore.launch()
    let finishRead: (presence: string) => void = () => {}
    seam.probe.mockImplementation(() => new Promise((resolve) => (finishRead = resolve)))
    const choice = restore.check()
    await vi.waitFor(() => expect(seam.probe).toHaveBeenCalled())
    seam.adopted?.(OWNER)
    finishRead('missing')
    await expect(choice).resolves.toBe('resume')
    expect(seam.release).not.toHaveBeenCalled()
  })

  it('needs no release for a launch that holds no conversation claim', async () => {
    const restore = armed({})
    restore.launch()
    await expect(restore.check()).resolves.toBe('fresh')
    expect(seam.release).not.toHaveBeenCalled()
  })
})
