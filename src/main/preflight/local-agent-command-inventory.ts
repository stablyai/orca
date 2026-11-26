import { detectCommandsInInstallDirs } from '../../shared/agent-launch/installation/local-agent-install-dir-detection'
import { hasPathSeparatorToken } from '../../shared/agent-launch/installation/managed-agent-command-token'
import {
  findCommandsOnLocalPath,
  type AgentPathMatch
} from '../ipc/command-path/command-path-batch'
import { isOrcaAgentRuntimePath } from '../managed-agent-cli/managed-agent-cli-path'
import { resolveLoginShellEnvironment } from '../startup/shell-environment/login-shell-environment'
import {
  InventoryFsProbes,
  UNVERIFIED_FS_PROBE
} from '../../shared/shell/command-resolution/inventory-fs-probes'
import { readInstallDirectoriesViaWorker } from '../ipc/command-path/command-path-directory-worker-client'
import { buildLocalPreflightEnv } from '../ipc/preflight/preflight-local-env'
import { waitForPromiseWithSignal } from '../../shared/concurrency/abort-signal-reason'
import type { CommandInventory, InventoryPublication } from './agent-command-inventory-publication'

type LocalInventoryProgress = Omit<CommandInventory, 'probed'> & { probed: Set<string> }
export type LocalInventoryScan = {
  controller: AbortController
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
  progress: LocalInventoryProgress
): CommandInventory {
  return {
    found: new Set(progress.found),
    matches: new Map(progress.matches),
    probed: new Set([...progress.probed, ...progress.found]),
    incomplete: true
  }
}

export async function scanLocalAgentCommandInventory(
  commands: ReadonlySet<string>,
  readLoginPath: boolean,
  { matches, found, probed }: LocalInventoryProgress,
  onChange: () => void,
  signal: AbortSignal
): Promise<CommandInventory> {
  const env =
    buildLocalPreflightEnv() ??
    (readLoginPath
      ? await waitForPromiseWithSignal(resolveLoginShellEnvironment(), signal)
      : process.env)
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
  const overrideProbes = new InventoryFsProbes(signal, 'override')
  for (const command of direct) {
    await findCommandsOnLocalPath([command], {
      env,
      found,
      probes: overrideProbes,
      signal,
      onCommandComplete: resolveCommand
    })
  }
  const pathMisses = new Map(names.map((command) => [command, Promise.withResolvers<boolean>()]))
  const unverifiedPath = new Set<string>()
  const installerProbes = new InventoryFsProbes(signal, 'installer')
  let installs: Promise<void> | undefined
  const pathScan = new AbortController()
  const pathSignal = AbortSignal.any([signal, pathScan.signal])
  try {
    await findCommandsOnLocalPath(names, {
      env,
      inventory: { isRuntimePath: isOrcaAgentRuntimePath, matches },
      found,
      probes: new InventoryFsProbes(pathSignal),
      signal: pathSignal,
      inventoryCommandCount: commands.size,
      onMatch: onChange,
      onCommandComplete: (command, uncertain) => {
        const needsInstall = !found.has(command) && !hasPathSeparatorToken(command)
        pathMisses.get(command)?.resolve(needsInstall)
        if (!needsInstall) {
          resolveCommand(command, uncertain)
          return
        }
        installs ??= detectCommandsInInstallDirs(names, {
          probes: installerProbes,
          readDirectories: (dir) =>
            installerProbes.read(
              dir,
              'dirs',
              async () => (await readInstallDirectoriesViaWorker(dir)) ?? UNVERIFIED_FS_PROBE
            ),
          needsLookup: (name) => pathMisses.get(name)?.promise ?? Promise.resolve(false),
          complete: (name, user, installerUncertain) => {
            if (signal.aborted) {
              return
            }
            if (user && !isOrcaAgentRuntimePath(user)) {
              matches.set(name, { ...matches.get(name), user })
              found.add(name)
            }
            resolveCommand(name, installerUncertain || unverifiedPath.has(name))
          }
        })
        void installs.catch(() => {})
      },
      unverified: unverifiedPath
    })
  } finally {
    pathScan.abort()
    for (const miss of pathMisses.values()) {
      miss.resolve(false)
    }
  }
  await installs
  return { matches, found, probed }
}
