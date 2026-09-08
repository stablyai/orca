import { execFile } from 'node:child_process'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const webContentExecutable = '/WebContentExtension.appex/com.apple.WebKit.WebContent'

export async function terminateHostedIosWebContent(
  deviceUdid,
  runCommand = execFileAsync,
  sendSignal = process.kill
) {
  const manager = await runCommand(
    'xcrun',
    ['simctl', 'spawn', deviceUdid, 'launchctl', 'managerpid'],
    commandOptions()
  )
  const managerPid = Number.parseInt(manager.stdout.trim(), 10)
  if (!Number.isSafeInteger(managerPid) || managerPid < 1) {
    throw new Error('iOS Simulator launchd PID is unavailable')
  }
  const processes = await runCommand('ps', ['-axo', 'pid=,ppid=,command='], commandOptions())
  const webContentPid = selectHostedIosWebContentPid(processes.stdout, managerPid)
  sendSignal(webContentPid, 'SIGKILL')
  return webContentPid
}

export function selectHostedIosWebContentPid(processTable, managerPid) {
  const candidates = processTable.split(/\r?\n/u).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u)
    if (!match) {
      return []
    }
    const pid = Number.parseInt(match[1], 10)
    const parentPid = Number.parseInt(match[2], 10)
    return parentPid === managerPid && match[3].includes(webContentExecutable) ? [pid] : []
  })
  if (candidates.length !== 1) {
    throw new Error(`Expected one iOS WebContent process, found ${candidates.length}`)
  }
  return candidates[0]
}

function commandOptions() {
  return {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: 30_000
  }
}
