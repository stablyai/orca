import { describe, expect, it } from 'vitest'
import {
  documentModuleNames,
  documentModuleSource,
  exportedLifecycleFunctions,
  parseTimeEffects,
  sequenceCalls,
  topLevelDeclarationsReachAnElement
} from '../../test-support/webview-document-census'

// Module-level effects would bind mounts before lifecycle startup and evade stop; require declarations with inert initializers.
// Factory-local state declarations remain safe because each document call gets fresh bindings.
const DIRECTORY = import.meta.dirname

const ENTRY = 'native-document-entry'

const THE_SEQUENCE = 'create-terminal-document'

const MODULES = documentModuleNames(DIRECTORY, [ENTRY])

const moduleSource = (name: string) => documentModuleSource(DIRECTORY, name)

const sequenceCallsTo = (functionName: string) =>
  sequenceCalls(moduleSource(THE_SEQUENCE), functionName, [
    'startTerminalDocument',
    'stopTerminalDocument'
  ])

describe('the document modules at parse time', () => {
  it('do no work: every effect is in a start function the hosts call', () => {
    expect(MODULES.length).toBeGreaterThan(30)
    expect(MODULES.flatMap((name) => parseTimeEffects(name, moduleSource(name)))).toEqual([])
  })

  it('declare nothing that reaches an element', () => {
    // Element reads in declaration initializers are still effects; check every module.
    for (const name of MODULES) {
      expect({
        name,
        reaches: topLevelDeclarationsReachAnElement(name, moduleSource(name))
      }).toEqual({ name, reaches: false })
    }
  })

  it('start and stop: the sequence calls every one there is, and undoes them in reverse', () => {
    // Compare start/stop names, not counts, so exported-but-unused lifecycle hooks cannot pass.
    // stopEdgeScroll is owned by stopSelectionOverlay rather than the top-level sequence.
    const exported = (keyword: 'start' | 'stop') =>
      MODULES.filter((name) => name !== THE_SEQUENCE).flatMap((name) =>
        exportedLifecycleFunctions(moduleSource(name), keyword, 'TerminalDocumentScope')
      )

    const started = sequenceCallsTo('startTerminalDocument')
    const stopped = sequenceCallsTo('stopTerminalDocument').filter(
      (name) => name !== 'cancelDocumentFrames'
    )
    expect([...started].sort()).toEqual(exported('start').sort())
    expect([...stopped].sort()).toEqual(
      exported('stop')
        .filter((name) => name !== 'stopEdgeScroll')
        .sort()
    )

    const paired = started.filter((name) => stopped.includes(name.replace(/^start/, 'stop')))
    expect(paired.map((name) => name.replace(/^start/, 'stop'))).toEqual(
      stopped.filter((name) => paired.includes(name.replace(/^stop/, 'start'))).toReversed()
    )
    expect(sequenceCallsTo('stopTerminalDocument').at(-1)).toBe('cancelDocumentFrames')
  })
})
