import { defineToolInputValue } from '../../../../shared/native-chat-tool-input-metadata'

export const TOOL_INPUT_LIMITS = {
  chars: 4000,
  metadata: 1024,
  nodes: 100,
  items: 20,
  depth: 5,
  key: 128,
  acquisition: 64000,
  serialized: 32768
} as const
export const INPUT_MARKER = '… (truncated)'
export type InputBudget = { chars: number; nodes: number }
export type InputWork = {
  preflight?: { openings: number; candidates: number; fixedProbes: number; whitespace: number }
  visits: number
  preflightVisits?: number
  openings: number
  candidates: number
  fixedProbes: number
  whitespace: number
  parses: number
  serializations: number
}
export const OMIT_INPUT = Symbol('omit tool input')
export function inputWork(): InputWork {
  return {
    openings: 0,
    candidates: 0,
    fixedProbes: 0,
    whitespace: 0,
    parses: 0,
    serializations: 0,
    visits: 0
  }
}

export function clipToolInput(text: string, cap: number): string {
  if (text.length <= cap) {
    return text
  }
  if (cap < INPUT_MARKER.length) {
    return ''
  }
  let end = cap - INPUT_MARKER.length
  const last = text.charCodeAt(end - 1),
    next = text.charCodeAt(end)
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    end--
  }
  return text.slice(0, end) + INPUT_MARKER
}

type Container = {
  entries?: [string, PropertyDescriptor][]
  descriptors: Map<string, PropertyDescriptor | undefined>
}

export class ToolInputProjection {
  private containers = new WeakMap<object, Container>()
  private active = new WeakSet<object>()
  private whitespaceResults = new Map<string, boolean>()
  readonly work: InputWork

  constructor(work: InputWork) {
    this.work = work
  }

  open(value: object): Container | undefined {
    const cached = this.containers.get(value)
    if (cached) {
      return cached
    }
    if (this.work.openings >= TOOL_INPUT_LIMITS.nodes) {
      return undefined
    }
    this.work.openings++
    const container: Container = { descriptors: new Map() }
    this.containers.set(value, container)
    return container
  }

  descriptor(value: object, key: string, fixed = true): PropertyDescriptor | undefined {
    const container = this.open(value)
    if (!container) {
      return undefined
    }
    if (!container.descriptors.has(key)) {
      if (fixed) {
        if (this.work.fixedProbes >= 190) {
          return undefined
        }
        this.work.fixedProbes++
      }
      container.descriptors.set(key, Object.getOwnPropertyDescriptor(value, key))
    }
    return container.descriptors.get(key)
  }

  read(value: object, key: string): unknown {
    const descriptor = this.descriptor(value, key)
    return descriptor && 'value' in descriptor ? descriptor.value : undefined
  }

  nonblank(value: string): boolean {
    const cached = this.whitespaceResults.get(value)
    if (cached !== undefined) {
      return cached
    }
    for (let index = 0; index < value.length; index++) {
      this.work.whitespace++
      if (!/\s/.test(value[index])) {
        this.whitespaceResults.set(value, true)
        return true
      }
    }
    this.whitespaceResults.set(value, false)
    return false
  }

  private entries(value: object): [string, PropertyDescriptor][] | undefined {
    const container = this.open(value)
    if (!container) {
      return undefined
    }
    if (container.entries) {
      return container.entries
    }
    const entries: [string, PropertyDescriptor][] = []
    container.entries = entries
    for (const key in value) {
      if (!Object.hasOwn(value, key)) {
        continue
      }
      this.work.candidates++
      const descriptor = this.descriptor(value, key, false)
      if (descriptor) {
        entries.push([key, descriptor])
      }
      if (entries.length >= TOOL_INPUT_LIMITS.items + 1) {
        break
      }
    }
    return entries
  }

  project(
    value: unknown,
    budget: InputBudget,
    depth: number,
    exact = false,
    omit?: ReadonlySet<string>
  ): unknown {
    this.work.visits++
    if (budget.nodes <= 0) {
      return OMIT_INPUT
    }
    if (typeof value === 'string') {
      if (exact && value.length > budget.chars) {
        return OMIT_INPUT
      }
      const text = clipToolInput(value, budget.chars)
      budget.nodes--
      budget.chars -= text.length
      return text
    }
    if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      budget.nodes--
      return value
    }
    if (!value || typeof value !== 'object') {
      return OMIT_INPUT
    }
    if (depth >= TOOL_INPUT_LIMITS.depth || this.active.has(value) || !this.open(value)) {
      return exact ? OMIT_INPUT : this.marker(budget)
    }
    budget.nodes--
    if (!exact && budget.nodes === 0) {
      return Array.isArray(value) ? [] : {}
    }
    this.active.add(value)
    const result = Array.isArray(value)
      ? this.array(value, budget, depth, exact)
      : this.record(value, budget, depth, exact, omit)
    this.active.delete(value)
    return result
  }

  marker(budget: InputBudget): unknown {
    if (budget.nodes < 1 || budget.chars < INPUT_MARKER.length) {
      return OMIT_INPUT
    }
    budget.nodes--
    budget.chars -= INPUT_MARKER.length
    return INPUT_MARKER
  }

  private array(value: unknown[], budget: InputBudget, depth: number, exact: boolean): unknown {
    const length = this.descriptor(value, 'length', false)?.value as number
    if (exact && length > TOOL_INPUT_LIMITS.items) {
      return OMIT_INPUT
    }
    const container = this.open(value)!
    if (!container.entries) {
      container.entries = []
      for (let index = 0; index < Math.min(length, TOOL_INPUT_LIMITS.items + 1); index++) {
        this.work.candidates++
        container.entries.push([String(index), this.descriptor(value, String(index), false) ?? {}])
      }
    }
    const result: unknown[] = []
    const truncated = length > TOOL_INPUT_LIMITS.items
    const count = Math.min(length, TOOL_INPUT_LIMITS.items - (truncated ? 1 : 0))
    for (let index = 0; index < count; index++) {
      if (budget.nodes <= 0) {
        return exact ? OMIT_INPUT : result
      }
      const descriptor = container.entries[index]?.[1]
      const item = descriptor && 'value' in descriptor ? descriptor.value : undefined
      let projected = this.project(item, budget, depth + 1, exact)
      if (projected === OMIT_INPUT) {
        if (exact) {
          return OMIT_INPUT
        }
        if (budget.nodes <= 0) {
          break
        }
        budget.nodes--
        projected = null
      }
      result.push(projected)
    }
    if (truncated) {
      const marker = this.marker(budget)
      if (marker !== OMIT_INPUT) {
        result.push(marker)
      }
    }
    return result
  }

  private record(
    value: object,
    budget: InputBudget,
    depth: number,
    exact: boolean,
    omit?: ReadonlySet<string>
  ): unknown {
    const result: Record<string, unknown> = {}
    const entries = this.entries(value)
    if (!entries) {
      return exact ? OMIT_INPUT : result
    }
    let count = 0,
      truncated = entries.length > TOOL_INPUT_LIMITS.items
    for (const [key, descriptor] of entries) {
      if (omit?.has(key)) {
        continue
      }
      if (count >= TOOL_INPUT_LIMITS.items - (truncated ? 1 : 0) || budget.nodes <= 0) {
        truncated = true
        break
      }
      if (!('value' in descriptor)) {
        if (exact) {
          return OMIT_INPUT
        }
        continue
      }
      if (key.length > TOOL_INPUT_LIMITS.key || key.length > budget.chars) {
        if (exact) {
          return OMIT_INPUT
        }
        truncated = true
        continue
      }
      budget.chars -= key.length
      const projected = this.project(descriptor.value, budget, depth + 1, exact)
      if (projected === OMIT_INPUT) {
        if (exact) {
          return OMIT_INPUT
        }
        continue
      }
      defineToolInputValue(result, key, projected)
      count++
    }
    if (truncated && exact) {
      return OMIT_INPUT
    }
    if (
      truncated &&
      !this.descriptor(value, '…') &&
      count < TOOL_INPUT_LIMITS.items &&
      budget.nodes > 0 &&
      budget.chars >= 10
    ) {
      budget.nodes--
      budget.chars -= 10
      defineToolInputValue(result, '…', 'truncated')
    }
    return result
  }
}
