import { win32 as pathWin32 } from 'node:path'
import { resolveWindowsGitBashShellPath } from '../../pty/shell-startup/git-bash'
import {
  resolveEffectiveWindowsPowerShell,
  type WindowsPowerShellImplementation,
  type WindowsPowerShellShellFamily
} from '../../providers/shell-launch/windows/powershell'
import { resolveWindowsPowerShellSpawnChain } from '../../providers/shell-launch/windows/powershell-executable'
import {
  configureWindowsShellPathHydration,
  hydrateShellPath,
  mergePathSegments,
  type HydrationResult
} from './hydrate-shell-path'

type WindowsShellPathHydrationOptions = {
  configure?: (
    shell: string | null | undefined,
    gitBashPath: string | null,
    fallbackShell: string | null
  ) => void
  hydrate?: () => Promise<HydrationResult>
  merge?: (segments: string[]) => string[]
  resolveGitBashPath?: (shell: string) => string | null
  resolvePowerShellChain?: (
    family: 'powershell.exe' | 'pwsh.exe',
    settingKey: string
  ) => string[] | Promise<string[]>
  warn?: (error: unknown) => void
}

export function createWindowsShellPathHydration(options: WindowsShellPathHydrationOptions = {}) {
  const configure = options.configure ?? configureWindowsShellPathHydration
  const hydrate = options.hydrate ?? hydrateShellPath
  const merge = options.merge ?? mergePathSegments
  const resolveGitBashPath = options.resolveGitBashPath ?? resolveWindowsGitBashShellPath
  const resolvePowerShellChain =
    options.resolvePowerShellChain ??
    ((family: 'powershell.exe' | 'pwsh.exe', settingKey: string) =>
      resolveWindowsPowerShellSpawnChain(family, { settingKey }))
  const warn =
    options.warn ??
    ((error: unknown) => {
      console.warn('[shell-path] Windows profile hydration failed; using inherited PATH:', error)
    })
  let generation = 0
  let ready = Promise.resolve()

  // PowerShell paths come from an async cached search; a newer request wins over a slower one.
  const setConfiguredShell = async (
    shell: string | null | undefined,
    implementation: WindowsPowerShellImplementation | undefined,
    requestGeneration: number
  ): Promise<void> => {
    const requestedShell = shell?.trim() || 'powershell.exe'
    const basename = pathWin32.basename(requestedShell).toLowerCase()
    const shellFamily: WindowsPowerShellShellFamily =
      basename === 'powershell.exe' || basename === 'pwsh.exe' ? basename : undefined
    const effectivePowerShell = resolveEffectiveWindowsPowerShell({
      shellFamily,
      implementation,
      pwshAvailable: true
    })
    if (!effectivePowerShell) {
      configure(requestedShell, resolveGitBashPath(requestedShell), null)
      return
    }
    const spawnChain = await resolvePowerShellChain(
      effectivePowerShell,
      `${requestedShell}|${implementation ?? ''}`
    )
    if (requestGeneration !== generation) {
      return
    }
    const profileShell = spawnChain[0] ?? 'cmd.exe'
    const fallbackShell = spawnChain.slice(1).find((candidate) => {
      const candidateBasename = pathWin32.basename(candidate).toLowerCase()
      return candidateBasename === 'powershell.exe' || candidateBasename === 'pwsh.exe'
    })
    configure(profileShell, null, fallbackShell ?? null)
  }

  return {
    configure: (shell, implementation?: WindowsPowerShellImplementation) => {
      generation += 1
      const configured = setConfiguredShell(shell, implementation, generation)
      ready = ready.then(() => configured)
    },
    hydrate: (shell, implementation?: WindowsPowerShellImplementation) => {
      generation += 1
      const requestGeneration = generation
      const configured = setConfiguredShell(shell, implementation, requestGeneration)
      ready = ready.then(async () => {
        await configured
        if (requestGeneration !== generation) {
          return
        }
        try {
          const result = await hydrate()
          if (requestGeneration === generation && result.ok) {
            merge(result.segments)
          }
        } catch (error) {
          if (requestGeneration === generation) {
            warn(error)
          }
        }
      })
      return ready
    },
    whenReady: async () => {
      let pending = ready
      while (true) {
        await pending
        if (pending === ready) {
          return
        }
        pending = ready
      }
    }
  }
}
