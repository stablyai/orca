import { describe, expect, it } from 'vitest'
import {
  collectTerminalLayoutLeafIds,
  buildOrchestrationTerminalGridRoot
} from '../../shared/orchestration-terminal-grid'
import type { TerminalLayoutSnapshot } from '../../shared/types'
import { OrcaRuntimeService } from './orca-runtime'

describe('orchestration grid renderer acknowledgement', () => {
  it('retains canonical live leaves omitted by a stale renderer subset', () => {
    const runtime = new OrcaRuntimeService()
    const canonicalLeafIds = ['leaf-a', 'leaf-b', 'leaf-c', 'leaf-new']
    const staged: TerminalLayoutSnapshot = {
      root: buildOrchestrationTerminalGridRoot(canonicalLeafIds),
      activeLeafId: 'leaf-a',
      expandedLeafId: null,
      layoutMode: 'orchestration-grid',
      ptyIdsByLeafId: {
        'leaf-a': 'pty-a',
        'leaf-b': 'pty-b',
        'leaf-c': 'pty-c'
      },
      titlesByLeafId: {
        'leaf-a': 'Worker A',
        'leaf-b': 'Worker B',
        'leaf-c': 'Worker C'
      }
    }
    const acknowledged: TerminalLayoutSnapshot = {
      root: buildOrchestrationTerminalGridRoot(['leaf-c', 'leaf-new']),
      activeLeafId: 'leaf-new',
      expandedLeafId: null,
      layoutMode: 'orchestration-grid',
      ptyIdsByLeafId: {
        'leaf-c': 'pty-c',
        'leaf-new': 'pty-new'
      }
    }
    const merge = (
      runtime as unknown as {
        mergeAcknowledgedOrchestrationGridLayout: (
          stagedLayout: TerminalLayoutSnapshot,
          acknowledgedLayout: TerminalLayoutSnapshot,
          leafId: string,
          ptyId: string
        ) => TerminalLayoutSnapshot
      }
    ).mergeAcknowledgedOrchestrationGridLayout.bind(runtime)

    const merged = merge(staged, acknowledged, 'leaf-new', 'pty-new')

    expect(collectTerminalLayoutLeafIds(merged.root)).toEqual(canonicalLeafIds)
    expect(merged.ptyIdsByLeafId).toEqual({
      'leaf-a': 'pty-a',
      'leaf-b': 'pty-b',
      'leaf-c': 'pty-c',
      'leaf-new': 'pty-new'
    })
    expect(merged.titlesByLeafId).toEqual({
      'leaf-a': 'Worker A',
      'leaf-b': 'Worker B',
      'leaf-c': 'Worker C'
    })
    expect(merged.activeLeafId).toBe('leaf-new')
  })
})
