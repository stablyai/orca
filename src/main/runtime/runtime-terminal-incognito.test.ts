import { describe, expect, it } from 'vitest'
import { resolveTerminalIncognito } from './runtime-terminal-incognito'
import type { GlobalSettings } from '../../shared/global-settings-types'

function settings(
  agents: GlobalSettings['terminalIncognitoAgents']
): Pick<GlobalSettings, 'terminalIncognitoAgents'> {
  return { terminalIncognitoAgents: agents }
}

describe('resolveTerminalIncognito', () => {
  it('honors an explicit per-terminal true', () => {
    expect(resolveTerminalIncognito({ incognito: true }, {}, () => settings([]))).toBe(true)
  })

  it('honors an explicit per-terminal false even when the agent is a default', () => {
    expect(
      resolveTerminalIncognito(
        { incognito: false, launchAgent: 'claude' },
        { launchAgent: 'claude' },
        () => settings(['claude'])
      )
    ).toBe(false)
  })

  it('applies the per-agent default for an incognito-capable agent', () => {
    expect(
      resolveTerminalIncognito({ launchAgent: 'pi' }, { launchAgent: 'pi' }, () => settings(['pi']))
    ).toBe(true)
  })

  it('matches the resolved launch agent even when only startupAgent was requested', () => {
    expect(
      resolveTerminalIncognito({ startupAgent: 'pi' }, { launchAgent: 'pi' }, () =>
        settings(['pi'])
      )
    ).toBe(true)
  })

  it('ignores the per-agent default for a non-incognito-capable agent', () => {
    // claude cannot be made ephemeral interactively, so a stale default must not take effect.
    expect(
      resolveTerminalIncognito({ launchAgent: 'claude' }, { launchAgent: 'claude' }, () =>
        settings(['claude'])
      )
    ).toBe(false)
  })

  it('is false for a capable agent not in the default list', () => {
    expect(
      resolveTerminalIncognito({ launchAgent: 'pi' }, { launchAgent: 'pi' }, () =>
        settings(['omp'])
      )
    ).toBe(false)
  })

  it('is false when there is no agent and no explicit flag', () => {
    expect(resolveTerminalIncognito({}, {}, () => settings(['claude']))).toBe(false)
  })

  it('is false when settings are unavailable', () => {
    expect(
      resolveTerminalIncognito(
        { launchAgent: 'claude' },
        { launchAgent: 'claude' },
        () => undefined
      )
    ).toBe(false)
  })
})
