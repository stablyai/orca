import { describe, expect, it } from 'vitest'
import { withRuntimeUnreachableHint } from './runtime-environment-unreachable-hint'

describe('withRuntimeUnreachableHint', () => {
  it('names the unreachable paired host and tells the caller how to recover', () => {
    expect(
      withRuntimeUnreachableHint(
        { name: 'M4Air mac' },
        'Remote Orca runtime closed the connection.',
        'wss://m4air.example.test'
      )
    ).toContain(
      "M4Air mac isn't answering; make sure Orca is running and connected on that host, then retry the command."
    )
  })
})
