import { defineToolInputValue } from '../../../../shared/native-chat-tool-input-metadata'
import { planToolInputAuthority } from './native-chat-tool-input-authority'
import {
  clipToolInput,
  inputWork,
  OMIT_INPUT,
  ToolInputProjection,
  TOOL_INPUT_LIMITS,
  type InputWork
} from './native-chat-tool-input-projection'

export function sanitizeToolInput(input: unknown, work: InputWork = inputWork()): unknown {
  const stringInput = typeof input === 'string'
  let value = input
  if (stringInput) {
    if (input.length > TOOL_INPUT_LIMITS.acquisition) {
      return clipToolInput(input, TOOL_INPUT_LIMITS.chars)
    }
    let index = 0
    while (index < input.length && /\s/.test(input[index])) {
      work.whitespace++
      index++
    }
    if (input[index] !== '{' && input[index] !== '[') {
      return clipToolInput(input, TOOL_INPUT_LIMITS.chars)
    }
    try {
      work.parses++
      value = JSON.parse(input)
    } catch {
      return clipToolInput(input, TOOL_INPUT_LIMITS.chars)
    }
  }
  const projection = new ToolInputProjection(work)
  let result: unknown
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const authority = planToolInputAuthority(value, projection)
    work.preflight = {
      openings: work.openings,
      candidates: work.candidates,
      fixedProbes: work.fixedProbes,
      whitespace: work.whitespace
    }
    work.preflightVisits = work.visits
    const budget = {
      chars: TOOL_INPUT_LIMITS.chars - (TOOL_INPUT_LIMITS.metadata - authority.budget.chars),
      nodes: authority.budget.nodes + 1
    }
    const bulk = projection.project(value, budget, 0, false, authority.omit)
    const record = authority.values
    const slots = Object.keys(record).length
    if (bulk && typeof bulk === 'object') {
      let count = slots
      for (const key of Object.keys(bulk)) {
        if (count >= TOOL_INPUT_LIMITS.items) {
          break
        }
        defineToolInputValue(record, key, (bulk as Record<string, unknown>)[key])
        count++
      }
    }
    result = record
  } else {
    result = projection.project(
      value,
      { chars: TOOL_INPUT_LIMITS.chars, nodes: TOOL_INPUT_LIMITS.nodes },
      0
    )
    if (result === OMIT_INPUT) {
      result = null
    }
  }
  work.serializations++
  let serialized = JSON.stringify(result)
  if (serialized.length > TOOL_INPUT_LIMITS.serialized) {
    result = Array.isArray(value) ? [] : {}
    work.serializations++
    serialized = JSON.stringify(result)
  }
  return stringInput ? serialized : result
}
