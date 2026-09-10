import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * orcad has no renderer and no Electron startup services, so what makes its terminals and its
 * agent chat work is a handful of single calls in one function. Each was missing once and none
 * failed loudly — a missing graph sentinel answers `runtime_unavailable`, unwired hook seams
 * answer empty. Pin them in source, the way the serve host's are pinned.
 */
const source = readFileSync(join(process.cwd(), 'src/main/orcad/orcad-entry.ts'), 'utf8')

describe('orcad headless startup wiring', () => {
  it('publishes the headless graph sentinel after PTY registration and before RPC', () => {
    const registration = source.indexOf('await registerHeadlessPtyRuntime(')
    const sentinel = source.indexOf(
      'runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID',
      registration
    )
    const rpc = source.indexOf('new OrcaRuntimeRpcServer(', sentinel)

    expect(registration).toBeGreaterThanOrEqual(0)
    expect(sentinel).toBeGreaterThan(registration)
    expect(rpc).toBeGreaterThan(sentinel)
    // The named constant, never the literal it happens to equal.
    expect(source).not.toContain('runtime.syncWindowGraph(0,')
  })

  it('starts the agent hook server before anything can spawn a PTY with a frozen env', () => {
    const hookServer = source.indexOf('await agentHookServer.start(')
    const daemon = source.indexOf('await startOrcadDaemon()', hookServer)
    const registration = source.indexOf('await registerHeadlessPtyRuntime(', daemon)

    expect(hookServer).toBeGreaterThanOrEqual(0)
    expect(daemon).toBeGreaterThan(hookServer)
    expect(registration).toBeGreaterThan(daemon)
  })

  it('reads hook status back into the runtime instead of only writing it', () => {
    const runtime = source.indexOf('new OrcaRuntimeService(')
    const deps = source.slice(runtime, source.indexOf('\n  })', runtime))

    expect(runtime).toBeGreaterThanOrEqual(0)
    // Without these the started server collects rows nothing reads: no transcript address
    // for native chat, and Claude resume refuses for want of a provider-session observation.
    for (const seam of [
      'onTerminalAgentStatus:',
      'getAgentStatusSnapshot:',
      'getAgentProviderSessionSnapshot:',
      'getAgentProviderSessionRowsForPane:',
      'attestAgentHookCompatibilityAuthority:',
      'retireAgentHookCompatibilityAuthority:',
      'reconcileAgentStatusForEndedProcess:'
    ]) {
      expect(deps).toContain(seam)
    }
  })

  it('stops the hook server on teardown and on a failed launch', () => {
    const hookServer = source.indexOf('await agentHookServer.start(')
    const armed = source.indexOf('stopOrcadAgentHookServer = () => agentHookServer.stop()')
    // Why the arming matters: startOrcad's failure path never imports the server, and a
    // listener left bound makes start()'s early return hand the next attempt a stale token.
    const failurePath = source.indexOf('return await startOrcadRuntime(')

    expect(armed).toBeGreaterThan(hookServer)
    expect(source.indexOf('stopOrcadAgentHookServer()', failurePath)).toBeGreaterThan(failurePath)
    expect(source.indexOf('agentHookServer.stop()', failurePath)).toBeGreaterThan(failurePath)
  })

  it('finishes teardown when a step rejects instead of skipping the rest', () => {
    const teardownStart = source.indexOf('stop: async () => {')
    const failurePath = source.slice(
      source.indexOf('return await startOrcadRuntime('),
      teardownStart
    )
    const teardown = source.slice(teardownStart)

    // Both awaits genuinely reject: `disconnectDaemon()` fans out over adapters with
    // `Promise.all` and awaits a checkpoint write, and the browser provider's stop() ends in
    // `rm()`, whose `force` forgives only ENOENT. In a flat sequence the first rejection skips
    // every later step, and the last one is `instanceLock.release()` — leak that lock file and
    // the next orcad launch refuses to start.
    const daemon = teardown.indexOf('await stopOrcadDaemon()')
    const hookStop = teardown.indexOf('agentHookServer.stop()', daemon)
    expect(daemon).toBeGreaterThanOrEqual(0)
    expect(teardown.slice(daemon, hookStop)).toContain('} finally {')

    const browserStop = teardown.indexOf('await browserProvider?.stop()', hookStop)
    const release = teardown.indexOf('instanceLock.release()', browserStop)
    expect(browserStop).toBeGreaterThanOrEqual(0)
    expect(teardown.slice(browserStop, release)).toContain('} finally {')

    // On the launch-failure path the original error is what the operator needs, so a teardown
    // rejection is caught there rather than allowed to replace it.
    const failureBrowserStop = failurePath.indexOf('await browserProvider?.stop()')
    const failureRelease = failurePath.indexOf('instanceLock.release()', failureBrowserStop)
    expect(failureBrowserStop).toBeGreaterThanOrEqual(0)
    expect(failurePath.slice(failureBrowserStop, failureRelease)).toContain('} catch (')
  })
})
