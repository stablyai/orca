import { describe, expect, it } from 'vitest'
import { selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'

describe('editor host model identity E2E routing', () => {
  const spec = 'tests/e2e/editor-model-host-isolation.spec.ts'
  it.each([
    'src/renderer/src/components/editor/model-lifetime/identity/editor-model-uri.ts',
    'src/renderer/src/components/editor/useEditorPanelFileContentLoader.ts',
    'src/renderer/src/lib/editor-file-operation-provenance.ts'
  ])('routes %s', (path) => {
    expect(selectPrE2eSpecs([path])).toContain(spec)
  })
  it('does not route unit tests of those sources', () => {
    expect(
      selectPrE2eSpecs([
        'src/renderer/src/components/editor/model-lifetime/identity/editor-model-uri.test.ts'
      ])
    ).not.toContain(spec)
  })
})
