import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { app } from 'electron'
import {
  SERVE_UPDATE_HANDOFF_PATH_ENV,
  getServeUpdateHandoffPath,
  parseServeUpdateHandoffState,
  type ServeSupervisorMessage,
  type ServeUpdateHandoffState
} from '../shared/serve-update-handoff'
import { getCanonicalUserDataPath } from './persistence'

function getConfiguredHandoffPath(): string | null {
  const configuredPath = process.env[SERVE_UPDATE_HANDOFF_PATH_ENV]
  if (!configuredPath) {
    return null
  }
  const expectedPath = getServeUpdateHandoffPath(getCanonicalUserDataPath())
  return resolve(configuredPath) === resolve(expectedPath) ? expectedPath : null
}

export function hasServeUpdateSupervisor(): boolean {
  return process.platform === 'darwin' && getConfiguredHandoffPath() !== null
}

export function requestServeUpdateHandoff(targetVersion: string): boolean {
  const handoffPath = getConfiguredHandoffPath()
  if (!handoffPath || !targetVersion) {
    return false
  }
  return writeHandoffState(handoffPath, {
    schemaVersion: 1,
    phase: 'install-requested',
    fromVersion: app.getVersion(),
    targetVersion,
    servingPid: process.pid
  })
}

export function failServeUpdateHandoff(reason: string): void {
  const handoffPath = getConfiguredHandoffPath()
  if (!handoffPath) {
    return
  }
  try {
    const state = parseServeUpdateHandoffState(JSON.parse(readFileSync(handoffPath, 'utf8')))
    if (state?.phase !== 'install-requested' || state.servingPid !== process.pid) {
      return
    }
    writeHandoffState(handoffPath, { ...state, phase: 'failed', reason })
  } catch {
    // The updater already reports the primary failure; a missing handoff file needs no second error.
  }
}

export function notifyServeSupervisorReady(runtimeId: string): void {
  if (!process.send || process.connected === false) {
    return
  }
  const message: ServeSupervisorMessage = {
    type: 'orca:serve-ready',
    version: app.getVersion(),
    runtimeId
  }
  try {
    process.send(message)
  } catch {
    // The disconnect listener owns parent-loss recovery; readiness reporting must not throw through startup.
  }
}

export function installServeSupervisorDisconnectQuit(
  isServeMode: boolean,
  parent: {
    once(event: 'disconnect', listener: () => void): unknown
    off(event: 'disconnect', listener: () => void): unknown
  } = process
): () => void {
  if (!isServeMode || !hasServeUpdateSupervisor()) {
    return () => undefined
  }
  const quit = (): void => app.quit()
  parent.once('disconnect', quit)
  return () => parent.off('disconnect', quit)
}

export function getServeUpdateHandoffFailure(): string | null {
  const handoffPath = getConfiguredHandoffPath()
  if (!handoffPath) {
    return null
  }
  try {
    const state = parseServeUpdateHandoffState(JSON.parse(readFileSync(handoffPath, 'utf8')))
    if (state?.phase !== 'failed') {
      return null
    }
    if (state.targetVersion === app.getVersion()) {
      unlinkSync(handoffPath)
      return null
    }
    return state.reason
  } catch {
    return null
  }
}

function writeHandoffState(path: string, state: ServeUpdateHandoffState): boolean {
  const temporaryPath = `${path}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temporaryPath, JSON.stringify(state), { mode: 0o600 })
    renameSync(temporaryPath, path)
    return true
  } catch {
    return false
  }
}
