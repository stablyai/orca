// Bedrock inference-profile IDs are namespaced by geography. The prefix selects
// the geographic routing band; an empty prefix means "use the raw model id as-is".
export function deriveInferenceProfilePrefix(region: string): string {
  if (!region) return ''
  if (region === 'global') return 'global.'
  if (region.startsWith('us-')) return 'us.'
  if (region.startsWith('eu-')) return 'eu.'
  if (region.startsWith('ap-')) return 'apac.'
  if (region.startsWith('jp-')) return 'jp.'
  return ''
}
