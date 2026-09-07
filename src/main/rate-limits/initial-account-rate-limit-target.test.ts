import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { getInitialClaudeRateLimitTarget } from './claude-rate-limit-target'
import { getInitialCodexRateLimitTarget } from './codex-rate-limit-target'

type RuntimeSelection = {
  host: string | null
  wsl: Record<string, string | null>
}

type Scenario = {
  name: string
  settings: Partial<GlobalSettings>
  expected: { runtime: 'host' } | { runtime: 'wsl'; wslDistro: string | null }
  legacy?: boolean
  platform?: NodeJS.Platform
  selection?: RuntimeSelection
}

const providers = [
  {
    name: 'Codex',
    getTarget: getInitialCodexRateLimitTarget,
    selectionSettings: (selection: RuntimeSelection) => ({
      activeCodexManagedAccountIdsByRuntime: selection
    })
  },
  {
    name: 'Claude',
    getTarget: getInitialClaudeRateLimitTarget,
    selectionSettings: (selection: RuntimeSelection) => ({
      activeClaudeManagedAccountIdsByRuntime: selection
    })
  }
] as const

const scenarios: Scenario[] = [
  {
    name: 'uses the trimmed configured WSL distro before the selected account',
    settings: {
      localAccountRuntime: 'wsl',
      localAccountWslDistro: ' Fedora ',
      localAgentRuntime: 'host',
      terminalWindowsWslDistro: 'Debian'
    },
    selection: { host: null, wsl: { Ubuntu: 'wsl-account-1' } },
    expected: { runtime: 'wsl', wslDistro: 'Fedora' }
  },
  {
    name: 'uses the single selected distro for an unpinned WSL runtime',
    settings: { localAccountRuntime: 'wsl' },
    selection: { host: 'host-account-1', wsl: { Ubuntu: 'wsl-account-1' } },
    expected: { runtime: 'wsl', wslDistro: 'Ubuntu' }
  },
  {
    name: 'ignores a stale terminal distro for an unpinned WSL runtime',
    settings: {
      localAccountRuntime: 'wsl',
      localAccountWslDistro: null,
      terminalWindowsWslDistro: 'Debian'
    },
    selection: { host: 'host-account-1', wsl: {} },
    expected: { runtime: 'wsl', wslDistro: null }
  },
  {
    name: 'keeps an explicit host runtime on host',
    settings: { localAccountRuntime: 'host', terminalWindowsShell: 'wsl.exe' },
    selection: { host: null, wsl: { Ubuntu: 'wsl-account-1' } },
    expected: { runtime: 'host' }
  },
  {
    name: 'ignores an explicit WSL runtime on non-Windows hosts',
    settings: { localAccountRuntime: 'wsl', localAccountWslDistro: 'Ubuntu' },
    platform: 'linux',
    expected: { runtime: 'host' }
  },
  {
    name: 'auto follows the global WSL runtime before stale selections',
    settings: {
      localAccountRuntime: 'auto',
      localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
    },
    selection: { host: null, wsl: { Debian: 'wsl-account-1' } },
    expected: { runtime: 'wsl', wslDistro: 'Ubuntu' }
  },
  {
    name: 'auto keeps the global host runtime before stale selections',
    settings: {
      localAccountRuntime: 'auto',
      localWindowsRuntimeDefault: { kind: 'windows-host' }
    },
    selection: { host: null, wsl: { Ubuntu: 'wsl-account-1' } },
    expected: { runtime: 'host' }
  },
  {
    name: 'legacy settings use the global WSL runtime before selections',
    settings: { localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' } },
    selection: { host: null, wsl: { Debian: 'wsl-account-1' } },
    legacy: true,
    expected: { runtime: 'wsl', wslDistro: 'Ubuntu' }
  },
  {
    name: 'legacy settings ignore stale agent and terminal WSL values',
    settings: {
      localWindowsRuntimeDefault: { kind: 'windows-host' },
      localAgentRuntime: 'wsl',
      localAgentWslDistro: 'Ubuntu',
      terminalWindowsShell: 'wsl.exe',
      terminalWindowsWslDistro: 'Debian'
    },
    legacy: true,
    expected: { runtime: 'host' }
  },
  {
    name: 'legacy settings preserve a single WSL selection on macOS',
    settings: {},
    selection: { host: null, wsl: { Ubuntu: 'wsl-account-1' } },
    legacy: true,
    platform: 'darwin',
    expected: { runtime: 'wsl', wslDistro: 'Ubuntu' }
  },
  {
    name: 'legacy settings map the provider default WSL key to no distro',
    settings: {},
    selection: { host: null, wsl: { __default__: 'wsl-account-1' } },
    legacy: true,
    platform: 'linux',
    expected: { runtime: 'wsl', wslDistro: null }
  },
  {
    name: 'legacy selection fallback requires no selected host account',
    settings: {},
    selection: { host: 'host-account-1', wsl: { Ubuntu: 'wsl-account-1' } },
    legacy: true,
    expected: { runtime: 'host' }
  },
  {
    name: 'legacy selection fallback requires exactly one selected WSL account',
    settings: {},
    selection: {
      host: null,
      wsl: { Debian: 'wsl-account-1', Fedora: null, Ubuntu: 'wsl-account-2' }
    },
    legacy: true,
    expected: { runtime: 'host' }
  }
]

describe.each(providers)('$name initial rate-limit target', ({ getTarget, selectionSettings }) => {
  it.each(scenarios)('$name', (scenario) => {
    const settings = {
      ...getDefaultSettings('/tmp'),
      ...scenario.settings,
      ...(scenario.selection ? selectionSettings(scenario.selection) : {})
    }
    if (scenario.legacy) {
      delete (settings as Partial<GlobalSettings>).localAccountRuntime
    }

    expect(getTarget(settings, scenario.platform ?? 'win32')).toEqual(scenario.expected)
  })
})
