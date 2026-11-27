import { detectCommandsInInstallDirs } from '../../shared/agent-launch/installation/local-agent-install-dir-detection'
import { hasPathSeparatorToken } from '../../shared/agent-launch/installation/managed-agent-command-token'
import {
  findCommandsOnLocalPath,
  type AgentPathMatch
} from '../ipc/command-path/command-path-batch'
import {
  createAgentRuntimeTargetCheck,
  isOrcaAgentRuntimePath
} from '../managed-agent-cli/managed-agent-cli-path'
import {
  captureLoginShellEnvironment,
  resolveLoginShellEnvironment
} from '../startup/shell-environment/login-shell-environment'
import {
  InventoryFsProbes,
  UNVERIFIED_FS_PROBE
} from '../../shared/shell/command-resolution/inventory-fs-probes'
import { readInstallDirectoriesViaWorker } from '../ipc/command-path/command-path-directory-worker-client'
import { buildLocalPreflightEnvAsync } from '../ipc/preflight/preflight-local-env'
import { guestNativeSpawnEnvAsync } from '../wsl/filesystem/wsl-guest-windows-drive-path'
import { waitForPromiseWithSignal } from '../../shared/concurrency/abort-signal-reason'
import {
  mergeInventory,
  type CommandInventory,
  type InventoryPublication
} from './agent-command-inventory-publication'

type LocalInventoryProgress = Omit<CommandInventory, 'probed'> & {
  probed: Set<string>
  unresolvedPathHits: Set<string>
}
export type LocalInventoryScan = {
  controller: AbortController
  loginPathCaptured?: true
  progress: LocalInventoryProgress
  changed: PromiseWithResolvers<void>
  finished?: boolean
  partial?: InventoryPublication
}

export function notifyScanChange(scan: LocalInventoryScan): void {
  const { changed } = scan
  scan.changed = Promise.withResolvers()
  changed.resolve()
}

export async function waitForLocalInventoryCommands(
  scan: LocalInventoryScan,
  requested: readonly string[],
  qualifiesEarly: (match: AgentPathMatch | undefined) => boolean,
  readPartial: () => CommandInventory | undefined,
  signal: AbortSignal
): Promise<CommandInventory | undefined> {
  while (!scan.finished && !scan.controller.signal.aborted) {
    const { changed, progress } = scan
    const probed = new Set<string>()
    for (const command of requested) {
      if (!progress.probed.has(command) && !qualifiesEarly(progress.matches.get(command))) {
        break
      }
      probed.add(command)
      if (progress.found.has(command)) {
        return { ...progress, probed }
      }
    }
    if (probed.size === requested.length) {
      return { ...progress, probed }
    }
    if (scan.partial) {
      const partial = readPartial()
      if (
        partial &&
        (requested.some((command) => partial.probed.has(command) && partial.found.has(command)) ||
          requested.every((command) => partial.probed.has(command)))
      ) {
        return partial
      }
    }
    await waitForPromiseWithSignal(changed.promise, signal)
  }
  return undefined
}

export function partialLocalAgentCommandInventory(
  progress: LocalInventoryProgress,
  previous?: CommandInventory
): CommandInventory {
  const snapshot = {
    found: new Set(progress.found),
    matches: new Map(progress.matches),
    probed: new Set([...progress.probed, ...progress.found]),
    incomplete: true
  }
  // A fresh PATH hit with unresolved precedence also invalidates the cached match.
  return mergeInventory(
    snapshot,
    previous,
    new Set([...snapshot.probed, ...progress.unresolvedPathHits]),
    true
  )
}

export async function scanLocalAgentCommandInventory(
  commands: ReadonlySet<string>,
  readLoginPath: boolean,
  shellPath: string | undefined,
  freshCapture: boolean,
  scan: LocalInventoryScan
): Promise<CommandInventory> {
  const { matches, found, probed, unresolvedPathHits } = scan.progress
  const signal = scan.controller.signal
  const onChange = () => notifyScanChange(scan)
  const captured =
    shellPath || (freshCapture && process.platform !== 'win32')
      ? await waitForPromiseWithSignal(
          captureLoginShellEnvironment({
            shellOverride: shellPath,
            exactPath: true,
            ...(freshCapture
              ? { startedAfter: Date.now() }
              : { refreshAfterMs: 5_000, keepCaptured: true })
          }),
          signal
        )
      : undefined
  if (captured) {
    scan.loginPathCaptured = true
  }
  const captureFailed = captured?.status === 'fallback'
  const fallbackMisses = captureFailed ? new Set<string>() : undefined
  const env =
    (captured?.status === 'captured'
      ? await waitForPromiseWithSignal(guestNativeSpawnEnvAsync(captured.env), signal)
      : undefined) ??
    (await waitForPromiseWithSignal(buildLocalPreflightEnvAsync(), signal)) ??
    (readLoginPath
      ? await waitForPromiseWithSignal(resolveLoginShellEnvironment(), signal)
      : process.env)
  if (!captured) {
    scan.loginPathCaptured = true
  }
  const direct: string[] = []
  const names: string[] = []
  for (const command of commands) {
    const hasSeparator =
      command.includes('/') || (process.platform === 'win32' && command.includes('\\'))
    const group = hasSeparator ? direct : names
    group.push(command)
  }
  const resolveCommand = (command: string, uncertain: boolean): void => {
    if (!signal.aborted && (found.has(command) || !uncertain)) {
      probed.add(command)
      onChange()
    }
  }
  // Serialize overrides within this scan while sharing issued probes by exact path.
  const overrideProbes = new InventoryFsProbes(signal)
  for (const command of direct) {
    await findCommandsOnLocalPath([command], {
      env,
      found,
      probes: overrideProbes,
      signal,
      onCommandComplete: resolveCommand
    })
  }
  const pathMisses: string[] = []
  const unverifiedPath = new Set<string>()
  const pathScan = new AbortController()
  const pathSignal = AbortSignal.any([signal, pathScan.signal])
  try {
    const probes = new InventoryFsProbes(pathSignal)
    await findCommandsOnLocalPath(names, {
      env,
      inventory: {
        isRuntimePath: isOrcaAgentRuntimePath,
        isRuntimeTarget: createAgentRuntimeTargetCheck(probes),
        pinPathMatches: captureFailed,
        matches,
        unresolvedHits: unresolvedPathHits
      },
      found,
      probes,
      signal: pathSignal,
      inventoryCommandCount: commands.size,
      onMatch: onChange,
      onCommandComplete: (command, uncertain, pathHit) => {
        if (!pathHit && !hasPathSeparatorToken(command)) {
          pathMisses.push(command)
        } else {
          resolveCommand(command, uncertain)
        }
      },
      unverified: unverifiedPath
    })
  } finally {
    pathScan.abort()
  }
  if (!signal.aborted && pathMisses.length) {
    const probes = new InventoryFsProbes(signal, 'installer')
    const isRuntime = createAgentRuntimeTargetCheck(probes)
    await detectCommandsInInstallDirs(pathMisses, {
      probes,
      acceptsExecutableTarget: async (target) => {
        const runtime = await isRuntime(target)
        return runtime === UNVERIFIED_FS_PROBE ? runtime : !runtime
      },
      readDirectories: (dir) =>
        probes.read(
          dir,
          'dirs',
          async () => (await readInstallDirectoriesViaWorker(dir)) ?? UNVERIFIED_FS_PROBE
        ),
      complete: (name, user, installerUncertain) => {
        if (signal.aborted) {
          return
        }
        if (user && !isOrcaAgentRuntimePath(user)) {
          matches.set(name, { ...matches.get(name), user })
          found.add(name)
        }
        const uncertain = installerUncertain || unverifiedPath.has(name)
        if (!uncertain && !found.has(name)) {
          fallbackMisses?.add(name)
        }
        resolveCommand(name, captureFailed || uncertain)
      }
    })
  }
  return { matches, found, probed, fallbackMisses }
}
