import type { ScryModel, ScryNode } from './model'
import type {
  ScryerModelSearchInput,
  ScryerModelSearchResult,
  ScryerSearchMatch
} from './types'
import { nodeMap, pathForNode } from './read-selector-model-navigation'
import { invalidInput, type SelectorResult } from './read-selector-result'

const SEARCH_CAP = 50
const FUZZY_THRESHOLD_LONG = 0.82
const FUZZY_THRESHOLD_SHORT = 0.9

function fieldScore(term: string, value: string): { score: number; exact: boolean } {
  const lower = value.toLowerCase()
  if (lower.includes(term)) {
    return { score: 1, exact: true }
  }
  const words = lower.split(/[^a-z0-9]+/i).filter(Boolean)
  return {
    score: words.reduce((best, word) => Math.max(best, jaroWinkler(term, word)), 0),
    exact: false
  }
}

function fuzzyThreshold(term: string): number {
  return term.length <= 4 ? FUZZY_THRESHOLD_SHORT : FUZZY_THRESHOLD_LONG
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100
}

function searchableFields(node: ScryNode): Array<{ field: string; value: string }> {
  return [
    { field: 'name', value: node.name },
    ...(node.description ? [{ field: 'description', value: node.description }] : []),
    ...(node.technology ? [{ field: 'technology', value: node.technology }] : []),
    ...(node.responsibilities ?? []).map((responsibility) => ({
      field: 'responsibility',
      value: responsibility.statement
    })),
    ...(node.properties ?? []).map((property) => ({
      field: 'property',
      value: property.label
    }))
  ]
}

function scoreNode(fields: Array<{ field: string; value: string }>, terms: string[]) {
  const bestByField = fields.map(() => ({ score: 0, exact: false }))
  let total = 0
  for (const term of terms) {
    let bestForTerm = 0
    fields.forEach((field, index) => {
      const score = fieldScore(term, field.value)
      if (score.score > bestByField[index]!.score) {
        bestByField[index] = score
      }
      bestForTerm = Math.max(bestForTerm, score.score)
    })
    if (bestForTerm < fuzzyThreshold(term)) {
      return null
    }
    total += bestForTerm
  }
  const matched: ScryerSearchMatch[] = fields.flatMap((field, index) => {
    const score = bestByField[index]!
    return score.score >= FUZZY_THRESHOLD_LONG
      ? [
          {
            field: field.field,
            value: field.value,
            match: score.exact ? 'exact' : 'fuzzy',
            score: roundScore(score.score)
          }
        ]
      : []
  })
  return { score: roundScore(total), matched }
}

export function selectModelSearch(
  model: ScryModel,
  input: ScryerModelSearchInput
): SelectorResult<ScryerModelSearchResult> {
  const layer = input.layer ?? 'plan'
  const terms = input.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) {
    return invalidInput('query', 'search query must contain at least one term')
  }
  const nodes = nodeMap(model)
  const scored = model.nodes.flatMap((node, index) => {
    if (input.kind && node.kind !== input.kind) {
      return []
    }
    const score = scoreNode(searchableFields(node), terms)
    if (!score) {
      return []
    }
    return [
      {
        index,
        hit: {
          id: node.id,
          kind: node.kind,
          name: node.name,
          path: pathForNode(node, nodes),
          score: score.score,
          matched: score.matched,
          ...(node.parentId ? { parentId: node.parentId } : {})
        }
      }
    ]
  })
  const sorted = scored.sort(
    (left, right) => right.hit.score - left.hit.score || left.index - right.index
  )
  const hits = sorted.slice(0, SEARCH_CAP).map(({ hit }) => hit)
  return {
    ok: true,
    result: {
      layer,
      query: input.query,
      ...(input.kind ? { kind: input.kind } : {}),
      resultCount: hits.length,
      truncated: scored.length > SEARCH_CAP,
      hits
    }
  }
}

function jaroWinkler(left: string, right: string): number {
  if (left === right) {
    return 1
  }
  if (left.length === 0 || right.length === 0) {
    return 0
  }
  const matchDistance = Math.max(Math.floor(Math.max(left.length, right.length) / 2) - 1, 0)
  const leftMatches = Array(left.length).fill(false) as boolean[]
  const rightMatches = Array(right.length).fill(false) as boolean[]
  let matches = 0
  for (let i = 0; i < left.length; i += 1) {
    const start = Math.max(0, i - matchDistance)
    const end = Math.min(i + matchDistance + 1, right.length)
    for (let j = start; j < end; j += 1) {
      if (rightMatches[j] || left[i] !== right[j]) {
        continue
      }
      leftMatches[i] = true
      rightMatches[j] = true
      matches += 1
      break
    }
  }
  if (matches === 0) {
    return 0
  }
  const leftMatched: string[] = []
  const rightMatched: string[] = []
  for (let i = 0; i < left.length; i += 1) {
    if (leftMatches[i]) {
      leftMatched.push(left[i])
    }
  }
  for (let i = 0; i < right.length; i += 1) {
    if (rightMatches[i]) {
      rightMatched.push(right[i])
    }
  }
  let transpositions = 0
  for (let i = 0; i < leftMatched.length; i += 1) {
    if (leftMatched[i] !== rightMatched[i]) {
      transpositions += 1
    }
  }
  const jaro =
    (matches / left.length + matches / right.length + (matches - transpositions / 2) / matches) / 3
  let prefix = 0
  for (let i = 0; i < Math.min(4, left.length, right.length); i += 1) {
    if (left[i] !== right[i]) {
      break
    }
    prefix += 1
  }
  return jaro + prefix * 0.1 * (1 - jaro)
}
