import { describe, expect, it, vi } from 'vitest'
import '../../construction/test-context/runtime-test-module-registration.spec'
import '../../orca-runtime'
import '../../orca-runtime-test-mocks/setup.spec'

import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import {
  declarePendingPaneSerializer,
  settlePendingPaneSerializer
} from '../../../ipc/pty/pane/serializer-state'
import { seedHeadlessTerminalFromSpawnResult } from '../../../ipc/pty/pane/terminal-spawn-restore'

import {
  createRuntime,
  syncSinglePty
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('keeps pre-TUI shell scrollback when hydrating from a renderer on the alternate screen (#6106)', async () => {
    // Renderer serialization emits normal scrollback before alt-screen bytes; zeroing scrollback loses shell history.
    const serializeBuffer = vi.fn(async (_ptyId: string, opts?: { scrollbackRows?: number }) => {
      const suppressesScrollback =
        (opts as Record<string, unknown> | undefined)?.altScreenForcesZeroRows === true
      const scrollback = suppressesScrollback ? '' : 'PRE_CODEX_START\r\nAGENTS.md\r\n'
      return {
        data: `${scrollback}\x1b[?1049h\x1b[HCodex TUI frame`,
        cols: 80,
        rows: 24
      }
    })
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeBuffer,
      hasRendererSerializer: () => true,
      getSize: () => ({ cols: 80, rows: 24 })
    })
    await syncSinglePty(runtime, 'pty-1')

    runtime.onPtyData('pty-1', 'live byte', 100)

    const snapshot = await runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 1000 })
    const restored = `${snapshot?.scrollbackAnsi ?? ''}${snapshot?.data ?? ''}`
    expect(restored).toContain('PRE_CODEX_START')
    expect(restored).toContain('AGENTS.md')
  })

  it('retains cold-restored history in hidden-output recovery while renderer serialization is pending', async () => {
    const runtime = createRuntime()
    await syncSinglePty(runtime, 'cold-pty')
    const paneKey = makePaneKey('tab-1', '44444444-4444-4444-8444-444444444444')
    const generation = declarePendingPaneSerializer(paneKey, undefined)
    try {
      seedHeadlessTerminalFromSpawnResult(
        runtime,
        {
          id: 'cold-pty',
          coldRestore: { scrollback: 'restored history\r\n', cwd: '/tmp', cols: 40, rows: 6 }
        },
        paneKey
      )
      runtime.onPtyData('cold-pty', 'fresh shell prompt $ ', 100)

      const snapshot = await runtime.serializeHiddenOutputRecoveryBuffer('cold-pty', {
        scrollbackRows: 100
      })
      expect(snapshot?.data).toContain('restored history')
      expect(snapshot?.data).toContain('fresh shell prompt $ ')
    } finally {
      settlePendingPaneSerializer(paneKey, generation)
    }
  })
})
