import type { CommandHandler } from '../dispatch'
import { formatLogcat } from '../emulator-logcat-format'
import { parseEmulatorPermissionRequest } from '../emulator-permissions-args'
import { printResult } from '../format'
import { resolveRepoPathArgument } from '../repo-path-arguments'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredFiniteNumber,
  getRequiredStringFlag
} from '../flags'
import { getEmulatorCommandTarget } from '../selectors'
import { RuntimeClientError } from '../runtime-client'

type EmulatorAttachResult = {
  info?: {
    deviceUdid?: string
    streamUrl?: string
  }
  deviceUdid?: string
  streamUrl?: string
}

type EmulatorKillResult = {
  deviceUdid?: string
}

type EmulatorShutdownResult = EmulatorKillResult

type EmulatorGesturePoint = {
  edge?: number
  type: 'begin' | 'move' | 'end'
  x: number
  y: number
}

type EmulatorDeviceRow = {
  backend?: 'ios' | 'android'
  id?: string
  name?: string
  state?: string
}

function formatEmulatorDevices(value: unknown): string {
  const devices = Array.isArray(value) ? (value as EmulatorDeviceRow[]) : []
  if (devices.length === 0) {
    return 'No emulator devices found.'
  }
  return devices
    .map((device) => {
      const platform = device.backend === 'android' ? 'Android' : 'iOS'
      return `${platform.padEnd(8)} ${(device.state ?? '').padEnd(9)} ${device.name ?? ''}  (${device.id ?? ''})`
    })
    .join('\n')
}

function assertNormalizedCoordinate(value: number, name: string): void {
  if (value < 0 || value > 1) {
    throw new RuntimeClientError('invalid_argument', `--${name} must be between 0 and 1`)
  }
}

function parseEmulatorGesturePoints(raw: string): EmulatorGesturePoint[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new RuntimeClientError('invalid_argument', '--points must be valid JSON')
  }
  const value =
    parsed && typeof parsed === 'object' && 'points' in parsed
      ? (parsed as { points?: unknown }).points
      : parsed
  if (!Array.isArray(value) || value.length < 2 || value.length > 64) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--points must be an array of 2 to 64 touch points'
    )
  }
  return value.map((point, index) => {
    if (!point || typeof point !== 'object') {
      throw new RuntimeClientError('invalid_argument', `gesture point ${index} must be an object`)
    }
    const candidate = point as Record<string, unknown>
    const type = candidate.type
    const edge = candidate.edge
    const x = candidate.x
    const y = candidate.y
    if (type !== 'begin' && type !== 'move' && type !== 'end') {
      throw new RuntimeClientError(
        'invalid_argument',
        `gesture point ${index} type must be begin, move, or end`
      )
    }
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new RuntimeClientError('invalid_argument', `gesture point ${index} x must be a number`)
    }
    if (typeof y !== 'number' || !Number.isFinite(y)) {
      throw new RuntimeClientError('invalid_argument', `gesture point ${index} y must be a number`)
    }
    assertNormalizedCoordinate(x, `points[${index}].x`)
    assertNormalizedCoordinate(y, `points[${index}].y`)
    if (
      edge !== undefined &&
      (typeof edge !== 'number' || !Number.isInteger(edge) || edge < 0 || edge > 4)
    ) {
      throw new RuntimeClientError(
        'invalid_argument',
        `gesture point ${index} edge must be an integer between 0 and 4`
      )
    }
    return edge === undefined ? { type, x, y } : { type, x, y, edge }
  })
}

export const EMULATOR_HANDLERS: Record<string, CommandHandler> = {
  'emulator list': async ({ flags, client, cwd, json }) => {
    const target = await getEmulatorCommandTarget(flags, cwd, client)
    const res = await client.call('emulator.list', { worktree: target.worktree })
    printResult(res, json, (v) => JSON.stringify(v, null, 2))
  },
  'emulator devices': async ({ flags, client, cwd, json }) => {
    const target = await getEmulatorCommandTarget(flags, cwd, client)
    const res = await client.call('emulator.listDevices', { worktree: target.worktree })
    printResult(res, json, formatEmulatorDevices)
  },
  'emulator attach': async ({ flags, client, cwd, json }) => {
    const target = await getEmulatorCommandTarget(flags, cwd, client)
    const device = getOptionalStringFlag(flags, 'device')
    const focus = flags.get('focus') === true
    // Why: attach may cold-boot or recycle a wedged simulator (shutdown + boot +
    // helper restart), which can legitimately exceed the 60s default budget.
    const res = await client.call(
      'emulator.attach',
      { device, worktree: target.worktree, focus },
      { timeoutMs: 180_000 }
    )
    printResult(res, json, (r: unknown) => {
      const result = r as EmulatorAttachResult
      const info = result.info ?? result
      const udid = info?.deviceUdid || device || 'default emulator'
      const stream = info?.streamUrl
      return `Attached to ${udid}${stream ? ` (preview: ${stream})` : ''}`
    })
  },
  'emulator tap': async ({ flags, client, cwd, json }) => {
    const target = await getEmulatorCommandTarget(flags, cwd, client)
    const x = getRequiredFiniteNumber(flags, 'x')
    const y = getRequiredFiniteNumber(flags, 'y')
    assertNormalizedCoordinate(x, 'x')
    assertNormalizedCoordinate(y, 'y')
    const res = await client.call('emulator.tap', {
      x,
      y,
      device: target.device,
      emulator: target.emulator,
      worktree: target.worktree
    })
    printResult(res, json, () => `Tapped (${x}, ${y})`)
  },
  'emulator type': async ({ flags, client, cwd, json }) => {
    const target = await getEmulatorCommandTarget(flags, cwd, client)
    const text = getRequiredStringFlag(flags, 'text')
    const res = await client.call('emulator.type', {
      text,
      device: target.device,
      emulator: target.emulator,
      worktree: target.worktree
    })
    printResult(res, json, () => 'Typed text')
  },
  'emulator gesture': async ({ flags, client, cwd, json }) => {
    const target = await getEmulatorCommandTarget(flags, cwd, client)
    const points = parseEmulatorGesturePoints(getRequiredStringFlag(flags, 'points'))
    const res = await client.call('emulator.gesture', {
      points,
      device: target.device,
      emulator: target.emulator,
      worktree: target.worktree
    })
    printResult(res, json, () => `Sent gesture with ${points.length} points`)
  },
  'emulator button': async ({ flags, client, cwd, json }) => {
    const target = await getEmulatorCommandTarget(flags, cwd, client)
    const name = getRequiredStringFlag(flags, 'name')
    const res = await client.call('emulator.button', {
      name,
      device: target.device,
      emulator: target.emulator,
      worktree: target.worktree
    })
    printResult(res, json, () => `Pressed ${name}`)
  },
  'emulator rotate': async ({ flags, client, cwd, json }) => {
    const target = await getEmulatorCommandTarget(flags, cwd, client)
    const orientation = getRequiredStringFlag(flags, 'orientation')
    const res = await client.call('emulator.rotate', {
      orientation,
      device: target.device,
      emulator: target.emulator,
      worktree: target.worktree
    })
    printResult(res, json, () => `Rotated ${orientation}`)
  },
  'emulator exec': async ({ flags, client, cwd, json }) => {
    const target = await getEmulatorCommandTarget(flags, cwd, client)
    const command = getRequiredStringFlag(flags, 'command')
    const res = await client.call('emulator.exec', {
      command,
      device: target.device,
      emulator: target.emulator,
      worktree: target.worktree
    })
    printResult(res, json, (r: unknown) => (typeof r === 'string' ? r : JSON.stringify(r, null, 2)))
  },
  'emulator kill': async ({ flags, client, cwd, json }) => {
    const target = await getEmulatorCommandTarget(flags, cwd, client)
    const res = await client.call('emulator.kill', {
      device: target.device,
      emulator: target.emulator,
      worktree: target.worktree
    })
    printResult(res, json, (r: unknown) => {
      const result = r as EmulatorKillResult
      return `Killed ${result.deviceUdid || target.device || 'emulator'}`
    })
  },
  'emulator shutdown': async ({ flags, client, cwd, json }) => {
    const target = await getEmulatorCommandTarget(flags, cwd, client)
    const res = await client.call('emulator.shutdown', {
      device: target.device,
      emulator: target.emulator,
      worktree: target.worktree
    })
    printResult(res, json, (r: unknown) => {
      const result = r as EmulatorShutdownResult
      return `Shut down ${result.deviceUdid || target.device || 'emulator'}`
    })
  },
  'emulator install': async ({ flags, client, cwd, json }) => {
    const target = await getEmulatorCommandTarget(flags, cwd, client)
    const apkPath = resolveRepoPathArgument(
      getRequiredStringFlag(flags, 'path'),
      cwd,
      client.isRemote,
      'Remote emulator install'
    )
    const res = await client.call('emulator.install', {
      path: apkPath,
      reinstall: flags.get('reinstall') === true,
      device: target.device,
      emulator: target.emulator,
      worktree: target.worktree
    })
    printResult(res, json, () => `Installed ${apkPath}`)
  },
  'emulator launch': async ({ flags, client, cwd, json }) => {
    const target = await getEmulatorCommandTarget(flags, cwd, client)
    const packageName = getRequiredStringFlag(flags, 'package')
    const res = await client.call('emulator.launch', {
      package: packageName,
      activity: getOptionalStringFlag(flags, 'activity'),
      device: target.device,
      emulator: target.emulator,
      worktree: target.worktree
    })
    printResult(res, json, () => `Launched ${packageName}`)
  },
  'emulator permissions': async ({ flags, client, cwd, json }) => {
    const target = await getEmulatorCommandTarget(flags, cwd, client)
    const request = parseEmulatorPermissionRequest(flags)
    const res = await client.call('emulator.permissions', {
      op: request.op,
      package: request.packageName,
      permission: request.permission,
      device: target.device,
      emulator: target.emulator,
      worktree: target.worktree
    })
    printResult(res, json, () =>
      request.op === 'reset' ? 'Reset runtime permissions' : `${request.op} ${request.packageName}`
    )
  },
  'emulator ax': async ({ flags, client, cwd, json }) => {
    const target = await getEmulatorCommandTarget(flags, cwd, client)
    const res = await client.call('emulator.ax', {
      device: target.device,
      emulator: target.emulator,
      worktree: target.worktree
    })
    printResult(res, json, (r) => JSON.stringify(r, null, 2))
  },
  'emulator logcat': async ({ flags, client, cwd, json }) => {
    const target = await getEmulatorCommandTarget(flags, cwd, client)
    const res = await client.call('emulator.logcat', {
      lines: getOptionalPositiveIntegerFlag(flags, 'lines'),
      device: target.device,
      emulator: target.emulator,
      worktree: target.worktree
    })
    printResult(res, json, formatLogcat)
  }
}
