import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../transport/rpc-client'
import { useMobileOrchestrationCrew } from './use-mobile-orchestration-crew'
import {
  emptyCrew,
  type OrchestrationCrewSnapshot
} from '../../../../src/shared/orchestration-crew'

const PARTY = 'term_agent'
const OTHER = 'term_other'

function crewClient() {
  let listener: ((value: unknown) => void) | null = null
  const subscribe = vi.fn((_method: string, _params: unknown, onData: (value: unknown) => void) => {
    listener = onData
    return () => {
      if (listener === onData) {
        listener = null
      }
    }
  })
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial RpcClient test double
    client: { subscribe } as unknown as RpcClient,
    emit: (value: unknown) => listener?.(value),
    subscribe
  }
}

function publishCrew(emit: (value: unknown) => void, label: string): void {
  emit({ type: 'begin', status: 'ok' })
  emit({
    type: 'rows',
    section: 'managing',
    rows: [
      {
        partyKey: label,
        role: 'worker',
        label,
        agentKind: 'hermes',
        status: 'waiting'
      }
    ]
  })
  emit({ type: 'complete' })
}

describe('useMobileOrchestrationCrew', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => {
      renderer?.unmount()
    })
    renderer = null
    vi.useRealTimers()
  })

  it('hides the previous crew when the party changes', () => {
    const crew = crewClient()
    let party = PARTY
    let snapshot: OrchestrationCrewSnapshot = emptyCrew('unknown')
    function Probe(): null {
      snapshot = useMobileOrchestrationCrew(crew.client, party)
      return null
    }
    act(() => {
      renderer = create(createElement(Probe))
    })
    act(() => {
      publishCrew(crew.emit, 'Worker')
    })
    expect(snapshot.sections.managing).toHaveLength(1)
    party = OTHER
    act(() => {
      renderer?.update(createElement(Probe))
    })
    expect(snapshot.sections.managing).toHaveLength(0)
    expect(snapshot.status).toBe('unknown')
  })

  it('hides the crew after the subscription retries run out', () => {
    vi.useFakeTimers()
    const crew = crewClient()
    let snapshot: OrchestrationCrewSnapshot = emptyCrew('unknown')
    function Probe(): null {
      snapshot = useMobileOrchestrationCrew(crew.client, PARTY)
      return null
    }
    act(() => {
      renderer = create(createElement(Probe))
    })
    act(() => {
      publishCrew(crew.emit, 'Worker')
    })
    expect(snapshot.sections.managing).toHaveLength(1)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      act(() => {
        crew.emit({ type: 'end' })
        vi.advanceTimersByTime((attempt + 1) * 1000)
      })
      expect(snapshot.sections.managing).toHaveLength(1)
    }
    act(() => {
      crew.emit({ type: 'end' })
    })
    expect(snapshot.sections.managing).toHaveLength(0)
    expect(snapshot.status).toBe('unknown')
  })
})
