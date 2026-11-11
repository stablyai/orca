import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))

const { noteCloudCreatePhase, noteCloudCreateProvisionChunk, resetCloudCreatePhaseTimingForTest } =
  await import('./cloud-create-phase-timing')

describe('cloud create phase timing (N-01)', () => {
  afterEach(() => {
    resetCloudCreatePhaseTimingForTest()
    vi.restoreAllMocks()
  })

  it('logs each phase with ms since the provision started, under a stable prefix', () => {
    const lines: string[] = []
    const log = (line: string): void => void lines.push(line)
    noteCloudCreatePhase('c1', 'provision-start', { now: 1000, log })
    noteCloudCreatePhase('c1', 'connecting', { now: 4200, log })
    noteCloudCreatePhase('c1', 'workspace-open', { now: 9000, log })
    expect(lines).toEqual([
      '[orca-cloud] create c1 provision-start +0',
      '[orca-cloud] create c1 connecting +3200',
      '[orca-cloud] create c1 workspace-open +8000'
    ])
  })

  it('stamps the driver progress lines in a provision chunk and ignores everything else', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    noteCloudCreatePhase('c2', 'provision-start')
    noteCloudCreateProvisionChunk(
      'c2',
      '[orca-cloud] provisioning\nsome other line\n[orca-cloud] cloning octocat/Hello-World\n[orca-cloud] connecting\n'
    )
    const phases = info.mock.calls.map(([line]) => String(line).split(' ')[3])
    expect(phases).toEqual(['provision-start', 'provisioning', 'cloning', 'connecting'])
  })

  it('never logs an id that could carry anything but an id', () => {
    const lines: string[] = []
    noteCloudCreatePhase('bad id; token=abc', 'provision-start', { log: (l) => void lines.push(l) })
    noteCloudCreatePhase(undefined, 'provision-start', { log: (l) => void lines.push(l) })
    expect(lines).toEqual([])
  })
})
