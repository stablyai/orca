import { isPtyIncarnationId, type PtyIncarnationId } from '../../shared/pty-incarnation'
import { admittedSshRelayPtyIdBytes } from './ssh-pty-wire-admission'

export const MAX_SSH_PTY_SPAWN_EXIT_EVENTS_PER_OPERATION = 128
export const MAX_SSH_PTY_SPAWN_EXIT_BYTES_PER_OPERATION = 512 * 1024
export const MAX_PENDING_SSH_PTY_SPAWN_EXIT_OPERATIONS = 128

type PendingSshPtySpawn = {
  exits: { relayPtyId: string; incarnationId?: PtyIncarnationId }[]
  retainedBytes: number
  overflowed: boolean
}

export class SshPtySpawnExitRaceTracker {
  private pending = new Set<PendingSshPtySpawn>()

  begin(): PendingSshPtySpawn {
    if (this.pending.size >= MAX_PENDING_SSH_PTY_SPAWN_EXIT_OPERATIONS) {
      throw new Error('ssh_pty_spawn_exit_tracking_capacity')
    }
    const operation: PendingSshPtySpawn = {
      exits: [],
      retainedBytes: 0,
      overflowed: false
    }
    this.pending.add(operation)
    return operation
  }

  recordExit(relayPtyId: string, incarnationId: unknown): void {
    const idBytes = admittedSshRelayPtyIdBytes(relayPtyId)
    if (idBytes === null || (incarnationId !== undefined && !isPtyIncarnationId(incarnationId))) {
      return
    }
    const retainedBytes =
      idBytes + (isPtyIncarnationId(incarnationId) ? Buffer.byteLength(incarnationId, 'utf8') : 0)
    for (const operation of this.pending) {
      if (
        operation.overflowed ||
        operation.exits.length >= MAX_SSH_PTY_SPAWN_EXIT_EVENTS_PER_OPERATION ||
        operation.retainedBytes + retainedBytes > MAX_SSH_PTY_SPAWN_EXIT_BYTES_PER_OPERATION
      ) {
        operation.overflowed = true
        operation.exits.length = 0
        operation.retainedBytes = 0
        continue
      }
      operation.exits.push({
        relayPtyId,
        ...(isPtyIncarnationId(incarnationId) ? { incarnationId } : {})
      })
      operation.retainedBytes += retainedBytes
    }
  }

  didMatchingExitArrive(
    operation: PendingSshPtySpawn,
    result: { id: string; incarnationId?: PtyIncarnationId }
  ): boolean {
    return (
      operation.overflowed ||
      operation.exits.some(
        (exit) =>
          exit.relayPtyId === result.id &&
          (!exit.incarnationId ||
            !result.incarnationId ||
            exit.incarnationId === result.incarnationId)
      )
    )
  }

  finish(operation: PendingSshPtySpawn): void {
    this.pending.delete(operation)
    operation.exits.length = 0
    operation.retainedBytes = 0
  }
}
