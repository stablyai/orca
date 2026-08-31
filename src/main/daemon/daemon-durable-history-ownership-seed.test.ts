import { describe, expect, it } from 'vitest'
import { buildDurableCheckpointSnapshot } from './daemon-durable-history-snapshot'
import type { TerminalSnapshot } from './types'

const liveSnapshot = {
  snapshotAnsi: 'prompt',
  scrollbackAnsi: '',
  rehydrateSequences: '',
  cwd: '/tmp',
  cols: 80,
  rows: 24,
  scrollbackLines: 0,
  modes: {
    bracketedPaste: false,
    alternateScreen: false,
    applicationCursor: false,
    mouseTracking: false
  },
  terminalOwner: 'shell',
  outputSequence: 7
} as TerminalSnapshot

describe('durable checkpoint ownership seeding without disk history', () => {
  it('carries the live proof through a rebuild over benign pending records', async () => {
    const durable = await buildDurableCheckpointSnapshot({
      liveSnapshot,
      restoreInfo: null,
      pendingRecords: [{ kind: 'output', data: 'plain shell prompt\r\n' }]
    })
    expect(durable.terminalOwner).toBe('shell')
  })

  it('revokes the live proof when pending records re-enter a TUI', async () => {
    const durable = await buildDurableCheckpointSnapshot({
      liveSnapshot,
      restoreInfo: null,
      pendingRecords: [{ kind: 'output', data: '\x1b[?1049hLIVE-TUI' }]
    })
    expect(durable.terminalOwner).toBeUndefined()
  })
})
