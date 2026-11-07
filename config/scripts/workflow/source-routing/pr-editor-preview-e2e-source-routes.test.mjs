import { describe, expect, it } from 'vitest'
import { selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'

describe('CSV preview E2E routing', () => {
  it('routes CSV viewer sources, not their unit tests, to the CSV specs', () => {
    expect(selectPrE2eSpecs(['src/renderer/src/components/editor/csv/CsvCellValue.tsx'])).toEqual(
      expect.arrayContaining([
        'tests/e2e/csv-paged-preview.spec.ts',
        'tests/e2e/csv-table-editing.spec.ts',
        'tests/e2e/csv-url-links.spec.ts'
      ])
    )
    expect(
      selectPrE2eSpecs(['src/renderer/src/components/editor/csv/csv-parse.test.ts'])
    ).not.toContain('tests/e2e/csv-url-links.spec.ts')
  })
})
