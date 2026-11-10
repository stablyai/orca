import { describe, expect, it } from 'vitest'
import { CONSUMERS, consumerViolations, writerViolations } from './check-tab-map-seam-ratchet.mjs'

const BRIDGE =
  'src/renderer/src/components/native-chat/session/status/StructuredAgentSessionStatusBridge.tsx'
const rules = CONSUMERS.get(BRIDGE)

describe('tab-map seam guard', () => {
  it('rejects an ordinary handler reaching the cold path or walking a map', () => {
    const text = [
      'const reconcileFromSnapshot = () => getStructuredAgentSessionTabs(source)',
      'const reconcile = () => reconcileFromSnapshot()',
      'const ordinary = () => { reconcileFromSnapshot(); Object.keys(source) }'
    ].join('\n')
    expect(consumerViolations('bridge.tsx', text, rules)).toEqual([
      'bridge.tsx:3 reconcileFromSnapshot() outside a named cold path',
      'bridge.tsx:3 Object.keys outside a named cold path'
    ])
  })

  it('rejects an unreviewed value import, not type imports', () => {
    const text = [
      "import { wholeMap } from './new-walk'",
      "import type { Walk } from './new-walk'"
    ].join('\n')
    expect(consumerViolations('bridge.tsx', text, rules)).toEqual([
      'bridge.tsx:1 imports wholeMap; repaired consumers import only reviewed helpers'
    ])
  })

  it('follows a raw record through a local binding unless it is marked full resync', () => {
    const text = [
      'function raw(state) {',
      '  const next = { ...state.unifiedTabsByWorktree, [id]: tabs }',
      '  set({ unifiedTabsByWorktree: next })',
      '}',
      'function annotated(state) {',
      '  const next = { ...state.unifiedTabsByWorktree, [id]: tabs }',
      '  markFullResync(next, "hydration")',
      '  set({ unifiedTabsByWorktree: next })',
      '}'
    ].join('\n')
    expect(writerViolations('writer.ts', text)).toEqual([
      'writer.ts:3 raw unifiedTabsByWorktree record; build it with a replace helper or draft, or mark it full resync'
    ])
  })

  it('follows aliases of cold helpers and enumerators', () => {
    const text = [
      'const reconcileFromSnapshot = () => getStructuredAgentSessionTabs(source)',
      'const reconcile = () => reconcileFromSnapshot()',
      'const resync = reconcileFromSnapshot',
      'const keys = Object.keys'
    ].join('\n')
    expect(consumerViolations('bridge.tsx', text, rules)).toEqual([
      'bridge.tsx:3 reconcileFromSnapshot() outside a named cold path',
      'bridge.tsx:4 Object.keys outside a named cold path'
    ])
  })

  it('follows aliased raw records and requires annotation before publication', () => {
    const raw =
      'raw unifiedTabsByWorktree record; build it with a replace helper or draft, or mark it full resync'
    const text = [
      'function aliased(state) {',
      '  const next = { ...state.unifiedTabsByWorktree, [id]: tabs }',
      '  const unifiedTabsByWorktree = next',
      '  set({ unifiedTabsByWorktree })',
      '}',
      'function late(state) {',
      '  const next = { ...state.unifiedTabsByWorktree, [id]: tabs }',
      '  set({ unifiedTabsByWorktree: next })',
      '  markFullResync(next, "hydration")',
      '}',
      'function early(state) {',
      '  const next = { ...state.unifiedTabsByWorktree, [id]: tabs }',
      '  const alias = next',
      '  markFullResync(alias, "hydration")',
      '  set({ unifiedTabsByWorktree: alias })',
      '}'
    ].join('\n')
    expect(writerViolations('writer.ts', text)).toEqual([
      `writer.ts:4 ${raw}`,
      `writer.ts:8 ${raw}`
    ])
  })
})
