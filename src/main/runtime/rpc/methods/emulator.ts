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
    permission: 'workspace',
    params: ListParams,
    handler: async (params, { runtime }) => runtime.emulatorList(params)
  }),
  defineMethod({
    name: 'emulator.attach',
    permission: 'workspace',
    params: AttachParams,
    handler: async (params, { runtime }) => runtime.emulatorAttach(params)
  }),
  defineMethod({
    name: 'emulator.tap',
    permission: 'workspace',
    params: TapParams,
    handler: async (params, { runtime }) => runtime.emulatorTap(params)
  }),
  defineMethod({
    name: 'emulator.gesture',
    permission: 'workspace',
    params: GestureParams,
    handler: async (params, { runtime }) => runtime.emulatorGesture(params)
  }),
  defineMethod({
    name: 'emulator.type',
    permission: 'workspace',
    params: TypeParams,
    handler: async (params, { runtime }) => runtime.emulatorType(params)
  }),
  defineMethod({
    name: 'emulator.button',
    permission: 'workspace',
    params: ButtonParams,
    handler: async (params, { runtime }) => runtime.emulatorButton(params)
  }),
  defineMethod({
    name: 'emulator.rotate',
    permission: 'workspace',
    params: RotateParams,
    handler: async (params, { runtime }) => runtime.emulatorRotate(params)
  }),
  defineMethod({
    name: 'emulator.exec',
    permission: 'workspace',
    params: ExecParams,
    handler: async (params, { runtime }) => runtime.emulatorExec(params)
  }),
  defineMethod({
    name: 'emulator.kill',
    permission: 'workspace',
    params: KillParams,
    handler: async (params, { runtime }) => runtime.emulatorKill(params)
  }),
  defineMethod({
    name: 'emulator.shutdown',
    permission: 'workspace',
    params: ShutdownParams,
    handler: async (params, { runtime }) => runtime.emulatorShutdown(params)
  }),
  defineMethod({
    name: 'emulator.listSimulators',
    permission: 'workspace',
    params: EmulatorListSimulatorsParams,
    handler: async (params, { runtime }) => runtime.emulatorListSimulators(params)
  }),
  defineMethod({
    name: 'emulator.availability',
    permission: 'workspace',
    params: EmulatorAvailabilityParams,
    handler: async (params, { runtime }) => runtime.emulatorAvailability(params)
  }),
  defineMethod({
    name: 'emulator.listDevices',
    permission: 'workspace',
    params: EmulatorListDevicesParams,
    handler: async (params, { runtime }) => runtime.emulatorListDevices(params)
  }),
  defineMethod({
    name: 'emulator.install',
    permission: 'workspace',
    params: InstallParams,
    handler: async (params, { runtime }) => runtime.emulatorInstall(params)
  }),
  defineMethod({
    name: 'emulator.launch',
    permission: 'workspace',
    params: LaunchParams,
    handler: async (params, { runtime }) => runtime.emulatorLaunch(params)
  }),
  defineMethod({
    name: 'emulator.permissions',
    permission: 'workspace',
    params: PermissionsParams,
    handler: async (params, { runtime }) => runtime.emulatorPermissions(params)
  }),
  defineMethod({
    name: 'emulator.ax',
    permission: 'workspace',
    params: AxParams,
    handler: async (params, { runtime }) => runtime.emulatorAx(params)
  }),
  defineMethod({
    name: 'emulator.logcat',
    permission: 'workspace',
    params: LogcatParams,
    handler: async (params, { runtime }) => runtime.emulatorLogcat(params)
  }),
  defineMethod({
    name: 'emulator.unregisterActive',
    permission: 'workspace',
    params: EmulatorUnregisterActiveParams,
    handler: async (params, { runtime }) => runtime.emulatorUnregisterActive(params)
  })
]
