import type { BundledSkillSource } from './bundled-skill-sources'

export function findBundledSkillSource(
  sources: readonly BundledSkillSource[],
  name: string
): BundledSkillSource {
  const source = sources.find(
    (candidate) => candidate.name === name || candidate.aliases?.includes(name)
  )
  if (!source) {
    throw new Error(`bundled-skill-unknown: ${name}`)
  }
  return source
}
