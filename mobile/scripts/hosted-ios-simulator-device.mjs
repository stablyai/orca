import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function resolveHostedIosSimulatorUdid(requested) {
  const devices = await availableDevices()
  const matches = devices.filter((device) => device.udid === requested || device.name === requested)
  const selected = matches.find((device) => device.state === 'Booted') ?? matches[0]
  if (!selected?.udid) {
    throw new Error(`No available iOS Simulator matched "${requested}".`)
  }
  return selected.udid
}

export async function bootHostedIosSimulator(deviceUdid) {
  const selected = (await availableDevices()).find((device) => device.udid === deviceUdid)
  if (selected?.state !== 'Booted') {
    await execFileAsync('xcrun', ['simctl', 'boot', deviceUdid])
  }
  await execFileAsync('xcrun', ['simctl', 'bootstatus', deviceUdid, '-b'])
}

async function availableDevices() {
  const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'])
  return Object.values(JSON.parse(stdout).devices ?? {}).flat()
}
