import { waitForPromiseWithSignal } from '../../../shared/concurrency/abort-signal-reason'
import { wslDistroForPath } from '../../wsl/filesystem/wsl-unc-access-gate'
import {
  applyClaudePluginManifestNames,
  discoverClaudePluginSkillInstalls
} from './claude-plugin-skill-sources'
import { discoverPiPackageSkillSources } from './pi-package-skill-sources'
import { resolvePiAgentDir } from './pi-package-source-path'
import { stablePathId } from './skill-discovery-classification'
import type { SkillScanRoot } from './skill-discovery-sources'
import { isOnStoppedWslDistro, stoppedPluginRoot } from './skill-discovery-stopped-wsl-roots'

function stoppedPiPackageRoot(pathValue: string): SkillScanRoot {
  return {
    id: `pi-package-${stablePathId(pathValue)}`,
    label: 'Pi packages',
    path: pathValue,
    sourceKind: 'plugin',
    providers: ['agent-skills'],
    owner: 'pi'
  }
}

export async function discoverPluginSkillSources(args: {
  homeDir: string
  pluginCwd?: string
  gateStopped: boolean
  mayReadStopped: (path: string) => boolean
  includePlugins: boolean
  signal?: AbortSignal
}): Promise<{ roots: SkillScanRoot[]; unavailable: SkillScanRoot[] }> {
  if (!args.includePlugins) {
    return { roots: [], unavailable: [] }
  }
  const isPathStopped = async (pathValue: string): Promise<boolean> =>
    args.gateStopped &&
    !args.mayReadStopped(pathValue) &&
    wslDistroForPath(pathValue) !== null &&
    (await isOnStoppedWslDistro(pathValue))

  const unavailable: SkillScanRoot[] = []
  const pluginCwdStopped = args.pluginCwd !== undefined && (await isPathStopped(args.pluginCwd))
  if (args.pluginCwd && pluginCwdStopped) {
    unavailable.push(stoppedPluginRoot(args.pluginCwd))
  }
  const piAgentDir = resolvePiAgentDir({ homeDir: args.homeDir })
  const userPiStopped = await isPathStopped(piAgentDir)
  if (userPiStopped) {
    unavailable.push(stoppedPiPackageRoot(piAgentDir))
  }
  const activeCwd = args.pluginCwd && !pluginCwdStopped ? args.pluginCwd : undefined
  const [claudeRoots, piRoots] = await waitForPromiseWithSignal(
    Promise.all([
      activeCwd
        ? discoverClaudePluginSkillInstalls({
            homeDir: args.homeDir,
            cwd: activeCwd,
            signal: args.signal
          }).then((installs) => applyClaudePluginManifestNames(installs, args.signal))
        : Promise.resolve<SkillScanRoot[]>([]),
      discoverPiPackageSkillSources({
        homeDir: args.homeDir,
        ...(activeCwd ? { cwd: activeCwd } : {}),
        ...(userPiStopped ? { skipUserSettings: true } : {}),
        isPathBlocked: isPathStopped,
        unavailableOut: unavailable,
        signal: args.signal
      })
    ]),
    args.signal
  )
  return { roots: [...claudeRoots, ...piRoots], unavailable }
}
