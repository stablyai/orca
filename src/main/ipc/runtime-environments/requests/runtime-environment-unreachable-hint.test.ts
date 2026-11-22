import { describe, expect, it } from 'vitest'
import { withRuntimeUnreachableHint } from './runtime-environment-unreachable-hint'

describe('withRuntimeUnreachableHint', () => {
  const environment = { name: 'M4Air mac' }
  const message = 'Remote Orca runtime closed the connection.'

  it('names the unreachable paired host and tells the caller how to recover', () => {
    expect(withRuntimeUnreachableHint(environment, message, 'wss://m4air.example.test')).toContain(
      "M4Air mac isn't answering; make sure Orca is running and connected on that host, then check the command outcome before retrying."
    )
  })

  it('does not repeat the host guidance when a transport wraps the same error again', () => {
    const once = withRuntimeUnreachableHint(environment, message, 'wss://m4air.example.test')

    expect(withRuntimeUnreachableHint(environment, once, 'wss://m4air.example.test')).toBe(once)
  })
})
