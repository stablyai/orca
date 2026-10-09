import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  listHarmonyEmulatorInstances,
  parseInstanceDetails,
  parseInstanceNames
} from './harmony-emulator-instances'
import type { HarmonyCommandRunner } from './harmony-command-runner'
import type { HarmonySdkPaths } from './harmony-sdk-discovery'

const SDK: HarmonySdkPaths = {
  sdkRoot: '/sdk',
  hdc: '/sdk/hdc',
  emulator: '/sdk/Emulator'
}

const DETAILS = JSON.stringify([
  {
    name: 'Mate 90 Pro',
    instancePath: '/home/erik/.Huawei/Emulator/deployed/Mate 90 Pro',
    imageRoot: '/sdk/images',
    imageSubPath: 'phone',
    uuid: 'uuid-1',
    isRunning: 'true',
    'hw.hdc.port': '5555',
    deviceType: 'phone',
    'hw.lcd.single.width': '1280',
    'hw.lcd.single.height': '2832',
    'os.apiVersion': '26'
  },
  {
    name: 'MatePad Pro',
    instancePath: '/home/erik/.Huawei/Emulator/deployed/MatePad Pro',
    imageRoot: '/sdk/images',
    isRunning: 'false',
    'hw.hdc.port': 'notset',
    'hw.lcd.single.width': '2560',
    'hw.lcd.single.height': '1600'
  }
])

describe('parseInstanceDetails', () => {
  it('normalizes string booleans and numeric fields', () => {
    const [phone, tablet] = parseInstanceDetails(DETAILS)
    expect(phone).toMatchObject({
      name: 'Mate 90 Pro',
      isRunning: true,
      hdcPort: 5555,
      lcdWidth: 1280,
      lcdHeight: 2832,
      apiVersion: '26'
    })
    expect(tablet).toMatchObject({ isRunning: false, lcdWidth: 2560 })
    expect(tablet.hdcPort).toBeUndefined()
  })

  it('rescues a JSON array embedded in extra output', () => {
    const stdout = `warning: ignoring config\n${DETAILS}\n`
    expect(parseInstanceDetails(stdout)).toHaveLength(2)
  })

  it('returns [] for non-array or invalid JSON', () => {
    expect(parseInstanceDetails('{}')).toEqual([])
    expect(parseInstanceDetails('not json at all')).toEqual([])
  })

  it('skips entries missing name or instancePath', () => {
    const stdout = JSON.stringify([{ name: 'x' }, { instancePath: '/p' }, null])
    expect(parseInstanceDetails(stdout)).toEqual([])
  })
})

describe('parseInstanceNames', () => {
  it('keeps names with spaces and drops bracketed lines', () => {
    expect(parseInstanceNames('Mate 90 Pro\n[Info:x]\n\nMatePad Pro\n')).toEqual([
      'Mate 90 Pro',
      'MatePad Pro'
    ])
  })
})

describe('listHarmonyEmulatorInstances', () => {
  const deployedRoot = '/home/erik/.Huawei/Emulator/deployed'
  const io = {
    deployedRoots: [deployedRoot],
    listDirectory: vi.fn(() => [])
  }

  it('returns parsed details on success', async () => {
    const runner: HarmonyCommandRunner = async () => ({ stdout: DETAILS, stderr: '', code: 0 })
    const instances = await listHarmonyEmulatorInstances(runner, SDK, io)
    expect(instances).toHaveLength(2)
    expect(instances[0]?.name).toBe('Mate 90 Pro')
  })

  it('appends deployed directory names missing from details', async () => {
    const runner: HarmonyCommandRunner = async () => ({ stdout: DETAILS, stderr: '', code: 0 })
    const dirIO = {
      deployedRoots: [deployedRoot],
      listDirectory: vi.fn(() => ['Mate 90 Pro', 'Local Extra'])
    }
    const instances = await listHarmonyEmulatorInstances(runner, SDK, dirIO)
    expect(instances.map((instance) => instance.name)).toEqual([
      'Mate 90 Pro',
      'MatePad Pro',
      'Local Extra'
    ])
    expect(instances[2]?.instancePath).toBe(join(deployedRoot, 'Local Extra'))
  })

  it('falls back to plain names when details fail', async () => {
    const runner = vi.fn<HarmonyCommandRunner>(async () => ({
      stdout: 'Mate 90 Pro',
      stderr: '',
      code: 0
    }))
    const dirIO = {
      deployedRoots: [deployedRoot],
      listDirectory: vi.fn(() => ['Mate 90 Pro'])
    }
    const instances = await listHarmonyEmulatorInstances(runner, SDK, dirIO)
    expect(instances).toEqual([
      {
        name: 'Mate 90 Pro',
        instancePath: join(deployedRoot, 'Mate 90 Pro'),
        imageRoot: '',
        isRunning: false
      }
    ])
  })

  it('uses empty instance paths when the binary and directories disagree', async () => {
    const runner = vi.fn<HarmonyCommandRunner>(async () => ({
      stdout: 'Orphan Name',
      stderr: '',
      code: 0
    }))
    const dirIO = {
      deployedRoots: [deployedRoot],
      listDirectory: vi.fn(() => [])
    }
    const instances = await listHarmonyEmulatorInstances(runner, SDK, dirIO)
    expect(instances[0]?.instancePath).toBe('')
  })
})
