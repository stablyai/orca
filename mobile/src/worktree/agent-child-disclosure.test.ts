import { describe, expect, it } from 'vitest'
import { collapsedChildrenSignalState, partitionIdleChildren } from './agent-child-disclosure'
import type { AgentDotState } from './agent-row-display'

const children = (...states: AgentDotState[]) => states.map((dotState) => ({ dotState }))

describe('agent child disclosure', () => {
  it('keeps a lone idle child inline and groups two or more', () => {
    expect(partitionIdleChildren(children('working', 'idle')).idleChildren).toEqual([])
    expect(partitionIdleChildren(children('idle', 'done', 'idle'))).toEqual({
      activeChildren: children('done'),
      idleChildren: children('idle', 'idle')
    })
  })

  it('signals the most urgent hidden state and stays quiet for settled children', () => {
    expect(collapsedChildrenSignalState(children('working', 'waiting', 'idle'))).toBe('waiting')
    expect(collapsedChildrenSignalState(children('idle', 'done', 'unverifiable'))).toBeUndefined()
  })
})
