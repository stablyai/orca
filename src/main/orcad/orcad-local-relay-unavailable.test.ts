import { expect, it } from 'vitest'
import {
  classifyOrcadLocalRelaySocketError,
  OrcadLocalRelayUnavailableError
} from './orcad-local-relay-unavailable'

it.each(['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'])(
  'preserves %s as the cause of a classified transport outage',
  (code) => {
    const cause = Object.assign(new Error('socket unavailable'), { code })
    const error = classifyOrcadLocalRelaySocketError(cause)
    expect(error).toBeInstanceOf(OrcadLocalRelayUnavailableError)
    expect(error.cause).toBe(cause)
  }
)

it.each(['EACCES', 'EPERM', 'EINVAL', 'EMFILE', 'ENFILE', undefined])(
  'does not downgrade %s into a source outage',
  (code) => {
    const error = Object.assign(new Error('socket failure'), { code })
    expect(classifyOrcadLocalRelaySocketError(error)).toBe(error)
  }
)
