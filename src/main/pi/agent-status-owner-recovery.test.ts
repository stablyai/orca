import { describe, expect, it } from 'vitest'
import {
  createAgentStatusExtensionHarness as createHarness,
  AGENT_STATUS_EXTENSION_SELF_PID as SELF_PID
} from './agent-status-extension-test-harness'

describe('Pi status owner recovery', () => {
  it.each(['pi', 'omp', 'prime-agent'] as const)(
    'claims the pane for a restarted %s agent whose inherited owner PID is dead',
    async (kind) => {
      // STA-5245: restart can inherit a dead owner PID that would suppress every later status event.
      const ownerKey =
        kind === 'prime-agent' ? 'ORCA_PRIME_AGENT_STATUS_OWNED' : 'ORCA_PI_STATUS_OWNED'
      const harness = createHarness({
        kind,
        pid: SELF_PID,
        env: { [ownerKey]: String(SELF_PID - 1) },
        killImpl: () => {
          throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
        }
      })

      expect(harness.killMock).toHaveBeenCalledWith(SELF_PID - 1, 0)
      expect(harness.handlers.agent_end).toBeTypeOf('function')
      expect(harness.processEnv[ownerKey]).toBe(String(SELF_PID))

      await harness.callHook('agent_end')
      expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['EPERM', 'EACCES', 'EINVAL', undefined])(
    'keeps suppression for unverifiable probe error %s',
    (code) => {
      // EPERM cannot prove exit; claiming this pane would duplicate reporting.
      const harness = createHarness({
        kind: 'pi',
        pid: SELF_PID,
        env: { ORCA_PI_STATUS_OWNED: String(SELF_PID - 1) },
        killImpl: () => {
          throw Object.assign(new Error('probe failed'), { code })
        }
      })

      expect(harness.handlers).toEqual({})
      expect(harness.processEnv.ORCA_PI_STATUS_OWNED).toBe(String(SELF_PID - 1))
    }
  )

  it('claims the pane when the inherited owner PID is not a usable pid', () => {
    const harness = createHarness({
      kind: 'pi',
      pid: SELF_PID,
      env: { ORCA_PI_STATUS_OWNED: 'not-a-pid' }
    })

    expect(harness.killMock).not.toHaveBeenCalled()
    expect(harness.handlers.agent_end).toBeTypeOf('function')
    expect(harness.processEnv.ORCA_PI_STATUS_OWNED).toBe(String(SELF_PID))
  })

  it('claims the pane when the inherited owner PID exceeds safe integer precision', () => {
    const harness = createHarness({
      kind: 'pi',
      pid: SELF_PID,
      env: { ORCA_PI_STATUS_OWNED: '99999999999999999999999' }
    })

    expect(harness.killMock).not.toHaveBeenCalled()
    expect(harness.handlers.agent_end).toBeTypeOf('function')
    expect(harness.processEnv.ORCA_PI_STATUS_OWNED).toBe(String(SELF_PID))
  })

  it('claims the pane when the inherited owner PID exceeds the process API range', () => {
    const harness = createHarness({
      kind: 'pi',
      pid: SELF_PID,
      env: { ORCA_PI_STATUS_OWNED: String(2 ** 31) }
    })

    expect(harness.killMock).not.toHaveBeenCalled()
    expect(harness.handlers.agent_end).toBeTypeOf('function')
    expect(harness.processEnv.ORCA_PI_STATUS_OWNED).toBe(String(SELF_PID))
  })
})
