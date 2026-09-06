import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

export function pairingRuntimePidFromUserData(
  userData,
  readText = (filePath) => readFileSync(filePath, 'utf8')
) {
  try {
    const metadata = JSON.parse(readText(path.join(userData, 'orca-runtime.json')))
    return Number.isSafeInteger(metadata?.pid) && metadata.pid > 0 ? metadata.pid : null
  } catch {
    return null
  }
}

export function pairingDaemonPidsFromUserData(
  userData,
  readDirectory = (directory) => readdirSync(directory),
  readText = (filePath) => readFileSync(filePath, 'utf8')
) {
  const daemonDirectory = path.join(userData, 'daemon')
  try {
    return readDirectory(daemonDirectory)
      .filter((name) => /^daemon-v\d+\.pid$/.test(name))
      .flatMap((name) => {
        try {
          const metadata = JSON.parse(readText(path.join(daemonDirectory, name)))
          return Number.isSafeInteger(metadata?.pid) && metadata.pid > 0 ? [metadata.pid] : []
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

export function currentPairingDaemonPids(
  userData,
  knownPids,
  readDirectory = (directory) => readdirSync(directory),
  readText = (filePath) => readFileSync(filePath, 'utf8')
) {
  return [
    ...new Set([...knownPids, ...pairingDaemonPidsFromUserData(userData, readDirectory, readText)])
  ]
}

export function signalPairingRuntime(runtimePid, sendSignal = process.kill) {
  if (runtimePid) {
    sendSignal(runtimePid, 'SIGTERM')
  }
}

export function signalPairingDaemons(daemonPids, sendSignal = process.kill, signal = 'SIGTERM') {
  for (const daemonPid of daemonPids) {
    try {
      sendSignal(daemonPid, signal)
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        throw error
      }
    }
  }
}
