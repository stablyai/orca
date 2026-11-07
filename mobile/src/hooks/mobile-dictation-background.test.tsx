// Backgrounding takes the microphone on both phones (Android pauses it, iOS suspends the app); dictation must finish with what was heard rather than resume later with a silent gap.
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient, type FakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import type { DictationCapture } from '../platform/dictation-capture-contract'

const appState = vi.hoisted(() => ({ handlers: new Set<(state: string) => void>() }))

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_type: string, handler: (state: string) => void) => {
      appState.handlers.add(handler)
      return { remove: () => appState.handlers.delete(handler) }
    }
  },
  Platform: { OS: 'ios' }
}))

vi.mock('../platform/dictation-capture', () => {
  const capture: DictationCapture = {
    open: async () => ({ ok: true }),
    begin: () => true,
    end: async () => {},
    release: () => {},
    onChunk: () => ({ remove: () => {} }),
    onInterruption: () => ({ remove: () => {} })
  }
  return { useDictationCapture: () => capture }
})

import { useMobileDictation, type UseMobileDictationResult } from './use-mobile-dictation'

async function pump(rpc: FakeRpcClient): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    for (const request of rpc.requests.splice(0)) {
      request.resolve({
        id: 'desktop',
        ok: true,
        result: request.method === 'speech.dictation.finish' ? { text: 'what was heard' } : {}
      })
    }
    await Promise.resolve()
    await Promise.resolve()
  }
}

const held: { dictation: UseMobileDictationResult | null } = { dictation: null }

function dictation(): UseMobileDictationResult {
  const current = held.dictation
  if (current === null) {
    throw new Error('nothing mounted')
  }
  return current
}

describe('leaving the app while dictating', () => {
  it('finishes and inserts what was heard, but a permission prompt or brief inactive state does not', async () => {
    const rpc = createFakeRpcClient()
    const transcripts: string[] = []
    function Probe(): null {
      held.dictation = useMobileDictation({
        client: rpc,
        enabled: true,
        onTranscript: (text) => transcripts.push(text)
      })
      return null
    }
    act(() => {
      create(createElement(Probe))
    })
    await act(async () => {
      const started = dictation().start()
      // Android's permission prompt reports background while the start is still open.
      appState.handlers.forEach((handler) => handler('background'))
      await pump(rpc)
      await started
    })
    expect(dictation().status).toBe('recording')

    await act(async () => {
      appState.handlers.forEach((handler) => handler('inactive'))
      await pump(rpc)
    })
    expect(dictation().status).toBe('recording')

    await act(async () => {
      appState.handlers.forEach((handler) => handler('background'))
      await pump(rpc)
    })
    expect(transcripts).toEqual(['what was heard'])
    expect(dictation().status).toBe('idle')
  })
})
