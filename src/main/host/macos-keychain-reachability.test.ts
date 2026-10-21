import { describe, expect, it } from 'vitest'
import { probeMacosKeychainReachability } from './macos-keychain-reachability'

type RunResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
}

function runner(result: Partial<RunResult> | Error) {
  return async (): Promise<RunResult> => {
    if (result instanceof Error) {
      throw result
    }
    return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...result }
  }
}

describe('probeMacosKeychainReachability', () => {
  it('reads each security(1) outcome into a verdict', async () => {
    await expect(probeMacosKeychainReachability(runner({ code: 0 }))).resolves.toEqual({
      kind: 'reachable'
    })
    await expect(
      probeMacosKeychainReachability(
        runner({
          code: 37,
          stderr: 'security: SecKeychainCopySettings <NULL>: A default keychain could not be found.'
        })
      )
    ).resolves.toEqual({ kind: 'unavailable', reason: 'no_default_keychain' })
    await expect(
      probeMacosKeychainReachability(
        runner({ code: 36, stderr: 'security: User interaction is not allowed.' })
      )
    ).resolves.toEqual({ kind: 'unavailable', reason: 'interaction_not_allowed' })
    await expect(
      probeMacosKeychainReachability(runner({ code: null, timedOut: true }))
    ).resolves.toEqual({ kind: 'unavailable', reason: 'timeout' })
  })

  it('classifies by exit code when the message is localized', async () => {
    await expect(
      probeMacosKeychainReachability(runner({ code: 37, stderr: 'trousseau introuvable' }))
    ).resolves.toEqual({ kind: 'unavailable', reason: 'no_default_keychain' })
    await expect(
      probeMacosKeychainReachability(runner({ code: 36, stderr: 'interaction refusée' }))
    ).resolves.toEqual({ kind: 'unavailable', reason: 'interaction_not_allowed' })
  })

  it('keeps today’s behavior when it cannot tell', async () => {
    await expect(
      probeMacosKeychainReachability(runner({ code: 1, stderr: 'something else' }))
    ).resolves.toEqual({ kind: 'unknown' })
    await expect(probeMacosKeychainReachability(runner(new Error('ENOENT')))).resolves.toEqual({
      kind: 'unknown'
    })
  })
})
