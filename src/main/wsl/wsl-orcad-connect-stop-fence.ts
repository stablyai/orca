/**
 * E9 for a no-boot connect: its running check passes once, then deploy and launch run many guest
 * commands. A stop heard meanwhile (`wsl --terminate`, a holder exit) fences every later spawn, so
 * the connect fails instead of booting the distro again.
 */
import { onWslDistroGateNote } from '../wsl-background-distro-gate'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import type { WslDistroHolder } from './wsl-distro-holder-types'
import { WslDistroNotRunningError } from './wsl-orcad-connection-errors'
import type { WslOrcadDeployOptions } from './wsl-orcad-deploy'

export type WslConnectStopFence = {
  /** Throws once a stop of the distro was heard since the fence opened. */
  assertNotStopped(): void
  dispose(): void
}

export function openWslConnectStopFence(
  distro: string,
  onNote: typeof onWslDistroGateNote = onWslDistroGateNote
): WslConnectStopFence {
  const key = wslDistroHolderKey(distro)
  let stopped = false
  const unsubscribe = onNote((note) => {
    if (note.kind === 'stopped' && wslDistroHolderKey(note.distro) === key) {
      stopped = true
    }
  })
  return {
    assertNotStopped: () => {
      if (stopped) {
        throw new WslDistroNotRunningError(distro)
      }
    },
    dispose: unsubscribe
  }
}

/** Every command or upload through `transport` checks the fence before it spawns in the distro. */
export function fenceTransportOnStop<T extends OrcadHostTransport>(
  transport: T,
  fence: WslConnectStopFence
): T {
  const guarded =
    <A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      fence.assertNotStopped()
      return run.apply(transport, args)
    }
  const overrides: PropertyDescriptorMap = {
    exec: { value: guarded(transport.exec) },
    writeFile: { value: guarded(transport.writeFile) },
    uploadDirectory: { value: guarded(transport.uploadDirectory) }
  }
  const { execWithClosedStdin } = transport
  if (execWithClosedStdin) {
    overrides.execWithClosedStdin = { value: guarded(execWithClosedStdin) }
  }
  // Delegate rather than spread so prototype methods (and dispose) survive.
  return Object.create(transport, overrides)
}

/** A holder spawn re-checks the fence too: it would boot a distro stopped since the check. */
export function fenceHolderOnStop(
  holder: WslDistroHolder,
  fence: WslConnectStopFence
): WslDistroHolder {
  return {
    ...holder,
    ensureHeld: (distro, options) =>
      holder.ensureHeld(distro, {
        requireRunning: async () => {
          fence.assertNotStopped()
          return options?.requireRunning ? options.requireRunning() : true
        }
      })
  }
}

/** The deploy's transport, holder and re-check; a no-boot connect (with `requireRunning`) fences them. */
export function wslConnectDeploySpawns(
  distro: string,
  transport: OrcadHostTransport,
  { holder }: { holder?: WslDistroHolder },
  { requireRunning }: { requireRunning?: (distro: string) => Promise<boolean> }
): {
  options: Pick<WslOrcadDeployOptions, 'holder' | 'createTransport' | 'requireRunning'>
  dispose: () => void
} {
  if (!requireRunning) {
    return { options: { holder, createTransport: () => transport }, dispose: () => {} }
  }
  const fence = openWslConnectStopFence(distro)
  return {
    options: {
      holder: holder ? fenceHolderOnStop(holder, fence) : holder,
      createTransport: () => fenceTransportOnStop(transport, fence),
      requireRunning: async () => {
        fence.assertNotStopped()
        return requireRunning(distro)
      }
    },
    dispose: fence.dispose
  }
}
