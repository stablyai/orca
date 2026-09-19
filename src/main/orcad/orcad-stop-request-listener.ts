import { watch, unlinkSync, type FSWatcher } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ORCAD_STOP_REQUEST_FILENAME } from '../../shared/orcad-stop-request'
import { orcadManagedStopRequestFilename } from '../../shared/orcad-managed-stop-request'
import {
  createOrcadManagedStopRequestValidator,
  type OrcadManagedStopRequestContext
} from './orcad-managed-stop-request'

export type OrcadStopRequestListenerOptions = {
  installRoot: string
  watchDirectory?: typeof watch
  unlinkFile?: typeof unlinkSync
  pollIntervalMs?: number
  managedStop?: OrcadManagedStopRequestContext
  managedHome?: string
}

export type OrcadStopRequestListener = { close(): void }

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/** Slot-local request files avoid signaling a stale PID that the OS has already reused. */
export function installOrcadStopRequestListener(
  onRequest: () => void,
  options: OrcadStopRequestListenerOptions
): OrcadStopRequestListener {
  const directory = options.managedStop
    ? dirname(options.managedStop.instance.lockPath)
    : options.installRoot
  const filename = options.managedStop
    ? orcadManagedStopRequestFilename(options.managedStop.instance)
    : ORCAD_STOP_REQUEST_FILENAME
  const requestPath = join(directory, filename)
  const validate = options.managedStop
    ? createOrcadManagedStopRequestValidator(options.managedStop, options.managedHome)
    : null
  let consumed = false
  let closed = false
  const unlinkFile = options.unlinkFile ?? unlinkSync
  const consume = (): void => {
    if (closed || (validate && consumed)) {
      return
    }
    try {
      if (validate) {
        validate(requestPath)
        // Retain the request as recovery evidence until the controller confirms teardown.
        consumed = true
      } else {
        unlinkFile(requestPath)
      }
    } catch (error) {
      if (isMissingFileError(error)) {
        return
      }
      console.error('[orcad] failed to consume stop request:', error)
      return
    }
    onRequest()
  }
  let watcher: FSWatcher | null = null
  try {
    watcher = (options.watchDirectory ?? watch)(directory, (_event, changedFilename) => {
      if (!changedFilename || basename(String(changedFilename)) === filename) {
        consume()
      }
    })
    watcher.on('error', (error) => {
      console.error('[orcad] stop-request watcher failed:', error)
    })
    watcher.unref()
  } catch (error) {
    console.error('[orcad] stop-request watcher could not start:', error)
  }
  const poll = setInterval(consume, options.pollIntervalMs ?? 1_000)
  poll.unref()
  // Covers a request written after readiness but before the watcher was installed.
  consume()
  return {
    close: () => {
      closed = true
      watcher?.close()
      clearInterval(poll)
    }
  }
}
