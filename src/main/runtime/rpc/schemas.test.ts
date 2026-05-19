import { describe, expect, it } from 'vitest'
import { z, type ZodType } from 'zod'
import {
  BrowserTarget,
  OptionalBoolean,
  OptionalFiniteNumber,
  OptionalPlainString,
  OptionalPositiveInt,
  OptionalString
} from './schemas'
import {
  InterceptEnable,
  Screenshot,
  Scroll,
  TabClose,
  TabSwitch,
  Wait
} from './methods/browser-schemas'
import { TERMINAL_METHODS } from './methods/terminal'
import { WORKTREE_METHODS } from './methods/worktree'

function expectParses(schema: ZodType, value: unknown): void {
  const result = schema.safeParse(value)
  expect(result.success, result.success ? undefined : JSON.stringify(result.error.issues)).toBe(
    true
  )
}

function methodParams(
  methods: readonly { name: string; params: ZodType | null }[],
  name: string
): ZodType {
  const method = methods.find((candidate) => candidate.name === name)
  if (!method?.params) {
    throw new Error(`missing test method schema: ${name}`)
  }
  return method.params
}

describe('RPC optional pipe schemas', () => {
  it('accepts omitted shared optional helper fields', () => {
    const schema = z.object({
      finite: OptionalFiniteNumber,
      positive: OptionalPositiveInt,
      string: OptionalString,
      plain: OptionalPlainString,
      boolean: OptionalBoolean
    })

    expectParses(schema, {})
  })

  it('accepts omitted browser optional fields while required fields are present', () => {
    expectParses(Scroll, { direction: 'down' })
    expectParses(Screenshot, {})
    expectParses(TabSwitch, { page: 'page-1' })
    expectParses(TabClose, {})
    expectParses(Wait, {})
    expectParses(InterceptEnable, {})
    expectParses(BrowserTarget, {})
  })

  it('accepts omitted terminal and worktree optional fields while required fields are present', () => {
    expectParses(methodParams(TERMINAL_METHODS, 'terminal.split'), { terminal: 'terminal-1' })
    expectParses(methodParams(WORKTREE_METHODS, 'worktree.create'), { repo: 'repo-1' })
  })
})
