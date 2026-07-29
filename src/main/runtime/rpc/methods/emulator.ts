import { defineMethod, type RpcMethod } from '../core'
import path from 'node:path'
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

const InstallParams = z.object({
  path: z.string().refine((value) => path.isAbsolute(value), {
    message: 'path must be absolute'
  }),
  reinstall: z.boolean().optional(),
  device: z.string().optional(),
  emulator: z.string().optional(),
  worktree: z.string().optional()
})

const LaunchParams = z.object({
  package: z.string(),
  activity: z.string().optional(),
  device: z.string().optional(),
  emulator: z.string().optional(),
  worktree: z.string().optional()
})

const PermissionsParams = z
  .object({
    op: z.enum(['grant', 'revoke', 'reset']),
    package: z.string().optional(),
    permission: z.string().optional(),
    device: z.string().optional(),
    emulator: z.string().optional(),
    worktree: z.string().optional()
  })
  .superRefine((value, ctx) => {
    if (value.op === 'reset') {
      if (value.package) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['package'],
          message: 'package is not allowed for reset'
        })
      }
      if (value.permission) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['permission'],
          message: 'permission is not allowed for reset'
        })
      }
      return
    }
    if (!value.package) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['package'],
        message: 'package is required for grant/revoke'
      })
    }
    if (!value.permission) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['permission'],
        message: 'permission is required for grant/revoke'
      })
    }
  })

const AxParams = z.object({
  device: z.string().optional(),
  emulator: z.string().optional(),
  worktree: z.string().optional()
})

const LogcatParams = z.object({
  lines: z.number().int().positive().optional(),
  filters: z.array(z.string()).optional(),
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
    name: 'emulator.listDevices',
    params: z.object({ worktree: z.string().optional() }).partial(),
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
    params: z.object({ worktree: z.string().optional() }).partial(),
    handler: async (params, { runtime }) => runtime.emulatorUnregisterActive(params)
  })
]
