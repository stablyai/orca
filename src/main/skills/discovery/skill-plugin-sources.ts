import { waitForPromiseWithSignal } from '../../../shared/concurrency/abort-signal-reason'
import { wslDistroForPath } from '../../wsl/filesystem/wsl-unc-access-gate'
import { discoverPluginSkillSources as discoverWorkspacePluginSkillSources } from './plugin-skill-sources'
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
  const pluginCwdStopped =
    args.pluginCwd !== undefined &&
    (await waitForPromiseWithSignal(isPathStopped(args.pluginCwd), args.signal))
  if (args.pluginCwd && pluginCwdStopped) {
    unavailable.push(stoppedPluginRoot(args.pluginCwd), stoppedPiPackageRoot(args.pluginCwd))
  }
  args.signal?.throwIfAborted()
  const piAgentDir = resolvePiAgentDir({ homeDir: args.homeDir })
  const userPiStopped = await waitForPromiseWithSignal(isPathStopped(piAgentDir), args.signal)
  if (userPiStopped) {
    unavailable.push(stoppedPiPackageRoot(piAgentDir))
  }
  const activeCwd = args.pluginCwd && !pluginCwdStopped ? args.pluginCwd : undefined
  const [workspacePluginRoots, piRoots] = await waitForPromiseWithSignal(
    Promise.all([
      activeCwd
        ? discoverWorkspacePluginSkillSources({
            homeDir: args.homeDir,
            cwd: activeCwd,
            signal: args.signal
          })
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
  return { roots: [...workspacePluginRoots, ...piRoots], unavailable }
}
