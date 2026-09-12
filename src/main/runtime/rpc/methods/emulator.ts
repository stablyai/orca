import { defineMethod } from '../core'
import path from 'node:path'
import { z } from 'zod'
import {
  AttachParams,
  AxParams,
  ButtonParams,
  EmulatorAvailabilityParams,
  EmulatorListDevicesParams,
  EmulatorListSimulatorsParams,
  EmulatorUnregisterActiveParams,
  ExecParams,
  GestureParams,
  KillParams,
  LaunchParams,
  ListParams,
  LogcatParams,
  PermissionsParams,
  RotateParams,
  ShutdownParams,
  TapParams,
  TypeParams
} from '../../../../shared/rpc-contract/emulator-params'

const InstallParams = z.object({
  path: z.string().refine((value) => path.isAbsolute(value), {
    message: 'path must be absolute'
  }),
  reinstall: z.boolean().optional(),
  device: z.string().optional(),
  emulator: z.string().optional(),
  worktree: z.string().optional()
})

export const EMULATOR_METHODS = [
  defineMethod({
    name: 'emulator.list',
    params: ListParams,
    handler: async (params, { runtime }) => runtime.emulatorList(params)
  }),
  defineMethod({
    name: 'emulator.attach',
    params: AttachParams,
    handler: async (params, { runtime }) => runtime.emulatorAttach(params)
  }),
  defineMethod({
    name: 'emulator.tap',
    params: TapParams,
    handler: async (params, { runtime }) => runtime.emulatorTap(params)
  }),
  defineMethod({
    name: 'emulator.gesture',
    params: GestureParams,
    handler: async (params, { runtime }) => runtime.emulatorGesture(params)
  }),
  defineMethod({
    name: 'emulator.type',
    params: TypeParams,
    handler: async (params, { runtime }) => runtime.emulatorType(params)
  }),
  defineMethod({
    name: 'emulator.button',
    params: ButtonParams,
    handler: async (params, { runtime }) => runtime.emulatorButton(params)
  }),
  defineMethod({
    name: 'emulator.rotate',
    params: RotateParams,
    handler: async (params, { runtime }) => runtime.emulatorRotate(params)
  }),
  defineMethod({
    name: 'emulator.exec',
    params: ExecParams,
    handler: async (params, { runtime }) => runtime.emulatorExec(params)
  }),
  defineMethod({
    name: 'emulator.kill',
    params: KillParams,
    handler: async (params, { runtime }) => runtime.emulatorKill(params)
  }),
  defineMethod({
    name: 'emulator.shutdown',
    params: ShutdownParams,
    handler: async (params, { runtime }) => runtime.emulatorShutdown(params)
  }),
  defineMethod({
    name: 'emulator.listSimulators',
    params: EmulatorListSimulatorsParams,
    handler: async (params, { runtime }) => runtime.emulatorListSimulators(params)
  }),
  defineMethod({
    name: 'emulator.availability',
    params: EmulatorAvailabilityParams,
    handler: async (params, { runtime }) => runtime.emulatorAvailability(params)
  }),
  defineMethod({
    name: 'emulator.listDevices',
    params: EmulatorListDevicesParams,
    handler: async (params, { runtime }) => runtime.emulatorListDevices(params)
  }),
  defineMethod({
    name: 'emulator.install',
    params: InstallParams,
    handler: async (params, { runtime }) => runtime.emulatorInstall(params)
  }),
  defineMethod({
    name: 'emulator.launch',
    params: LaunchParams,
    handler: async (params, { runtime }) => runtime.emulatorLaunch(params)
  }),
  defineMethod({
    name: 'emulator.permissions',
    params: PermissionsParams,
    handler: async (params, { runtime }) => runtime.emulatorPermissions(params)
  }),
  defineMethod({
    name: 'emulator.ax',
    params: AxParams,
    handler: async (params, { runtime }) => runtime.emulatorAx(params)
  }),
  defineMethod({
    name: 'emulator.logcat',
    params: LogcatParams,
    handler: async (params, { runtime }) => runtime.emulatorLogcat(params)
  }),
  defineMethod({
    name: 'emulator.unregisterActive',
    params: EmulatorUnregisterActiveParams,
    handler: async (params, { runtime }) => runtime.emulatorUnregisterActive(params)
  })
]
