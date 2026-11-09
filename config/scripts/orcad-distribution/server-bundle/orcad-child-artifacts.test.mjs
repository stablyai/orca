import { expect, it } from 'vitest'
import { ORCAD_ARTIFACTS } from '../../../../src/shared/orcad-artifacts.ts'
import { ORCAD_CHILD_ENTRY_POINTS, orcadChildOutputFilename } from './orcad-entry-build.mjs'

// A child built but not listed never reaches remote hosts, so its client fails there.
it.each(Object.entries(ORCAD_CHILD_ENTRY_POINTS))(
  'ships the %s child bundle as an orcad artifact',
  (_name, entryPoint) => {
    const filenames = ORCAD_ARTIFACTS.map((artifact) => artifact.filename)
    expect(filenames).toContain(orcadChildOutputFilename(entryPoint))
  }
)
