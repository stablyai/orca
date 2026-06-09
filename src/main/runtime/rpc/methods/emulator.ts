import { defineMethod, type RpcMethod } from '../core'
import { z } from 'zod'

// Minimal schemas for emulator commands (loose for initial testing; can be tightened like browser-schemas).
const WorktreeParam = z.object({ worktree: z.string().optional() }).partial()

const TapParams = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  device: z.string().optional(),
  emulator: z.string().optional(),
  worktree: z.string().optional()
})

const GesturePoint = z.object({
  edge: z.number().int().min(0).max(4).optional(),
  type: z.enum(['begin', 'move', 'end']),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1)
})

const GestureParams = z.object({
  points: z.array(GesturePoint).min(2).max(64),
  device: z.string().optional(),
  emulator: z.string().optional(),
  worktree: z.string().optional()
})

const TypeParams = z.object({
  text: z.string(),
  device: z.string().optional(),
  emulator: z.string().optional(),
  worktree: z.string().optional()
})

const ButtonParams = z.object({
  name: z.string(),
  device: z.string().optional(),
  emulator: z.string().optional(),
  worktree: z.string().optional()
})

const RotateOrientation = z.enum([
  'portrait',
  'portrait_upside_down',
  'landscape_left',
  'landscape_right'
])

const RotateParams = z.object({
  orientation: RotateOrientation,
  device: z.string().optional(),
  emulator: z.string().optional(),
  worktree: z.string().optional()
})

const ExecParams = z.object({
  command: z.string(),
  device: z.string().optional(),
  emulator: z.string().optional(),
  worktree: z.string().optional()
})

const AttachParams = z.object({
  device: z.string().optional(),
  worktree: z.string().optional(),
  focus: z.boolean().optional()
})

const KillParams = z.object({
  device: z.string().optional(),
  emulator: z.string().optional(),
  worktree: z.string().optional()
})

const ShutdownParams = KillParams.extend({
  managedOnly: z.boolean().optional()
})

const ListParams = WorktreeParam

export const EMULATOR_METHODS: RpcMethod[] = [
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
    params: z.object({ worktree: z.string().optional() }).partial(),
    handler: async (params, { runtime }) => runtime.emulatorListSimulators(params)
  }),
  defineMethod({
    name: 'emulator.availability',
    params: z.object({ worktree: z.string().optional() }).partial(),
    handler: async (params, { runtime }) => runtime.emulatorAvailability(params)
  }),
  defineMethod({
    name: 'emulator.unregisterActive',
    params: z.object({ worktree: z.string().optional() }).partial(),
    handler: async (params, { runtime }) => runtime.emulatorUnregisterActive(params)
  })
]
