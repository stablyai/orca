import { describe, expect, it } from 'vitest'

import { collectLocalizationCandidates } from './audit-localization-coverage.mjs'

describe('mobile-localization-candidate-rules', () => {
  it('finds grammatical fragments returned by repositoryCount', () => {
    const source = `
function repositoryCount(count) {
  return \`\${count} \${count === 1 ? 'repository' : 'repositories'}\`
}
`
    const candidates = collectLocalizationCandidates('/repo/mobile/app/tasks.tsx', source, '/repo')

    expect(candidates.map((candidate) => candidate.text)).toEqual(['repository', 'repositories'])
  })
})
