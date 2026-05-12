/* eslint-disable max-lines -- Why: computer RPC schemas and sidecar dispatch stay together so provider behavior is audited in one place. */
import { z } from 'zod'
import {
  callComputerSidecarAction,
  callComputerSidecarCapabilities,
  callComputerSidecarListApps,
  callComputerSidecarListWindows,
  callComputerSidecarSnapshot,
  resetComputerSidecarForTest
} from '../../../computer/sidecar-client'
import { defineMethod, type RpcMethod } from '../core'
import {
  OptionalBoolean,
  OptionalFiniteNumber,
  OptionalPlainString,
  OptionalString,
  requiredStringAllowingEmpty,
  requiredString
} from '../schemas'

const OptionalNonNegativeInt = z.number().int().nonnegative().optional()
const OptionalPositiveInt = z.number().int().positive().optional()

const ComputerTarget = z.object({
  app: requiredString('Missing app'),
  session: OptionalString,
  worktree: OptionalPlainString
})

const ComputerObserveTargetBase = ComputerTarget.extend({
  noScreenshot: OptionalBoolean,
  restoreWindow: OptionalBoolean,
  windowId: OptionalNonNegativeInt,
  windowIndex: OptionalNonNegativeInt
})

function validateWindowTarget(
  value: { windowId?: number; windowIndex?: number },
  ctx: z.RefinementCtx
): void {
  if (value.windowId !== undefined && value.windowIndex !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'Window targeting accepts either --window-id or --window-index, not both'
    })
  }
}

const ComputerObserveTarget = ComputerObserveTargetBase.superRefine(validateWindowTarget)

const ListApps = z.object({
  worktree: OptionalPlainString
})

const ListWindows = ComputerTarget

const Click = ComputerObserveTargetBase.extend({
  elementIndex: OptionalNonNegativeInt,
  x: OptionalFiniteNumber,
  y: OptionalFiniteNumber,
  clickCount: OptionalPositiveInt,
  mouseButton: z.enum(['left', 'right', 'middle']).optional()
}).superRefine((value, ctx) => {
  validateWindowTarget(value, ctx)
  const hasElement = value.elementIndex !== undefined
  const hasX = value.x !== undefined
  const hasY = value.y !== undefined
  if (!hasElement && !(hasX && hasY)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Click requires --element-index or both --x and --y'
    })
  }
  if (hasX !== hasY) {
    ctx.addIssue({
      code: 'custom',
      message: 'Click coordinates require both --x and --y'
    })
  }
  if (hasElement && (hasX || hasY)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Click accepts either --element-index or coordinate flags, not both'
    })
  }
})

const PerformSecondaryAction = ComputerObserveTargetBase.extend({
  elementIndex: OptionalNonNegativeInt,
  action: requiredString('Missing action')
}).superRefine((value, ctx) => {
  validateWindowTarget(value, ctx)
  if (value.elementIndex === undefined) {
    ctx.addIssue({ code: 'custom', message: 'Missing element index' })
  }
})

const Scroll = ComputerObserveTargetBase.extend({
  elementIndex: OptionalNonNegativeInt,
  x: OptionalFiniteNumber,
  y: OptionalFiniteNumber,
  direction: z.enum(['up', 'down', 'left', 'right']),
  pages: z.number().positive().optional()
}).superRefine((value, ctx) => {
  validateWindowTarget(value, ctx)
  const hasElement = value.elementIndex !== undefined
  const hasX = value.x !== undefined
  const hasY = value.y !== undefined
  if (!hasElement && !(hasX && hasY)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Scroll requires --element-index or both --x and --y'
    })
  }
  if (hasX !== hasY) {
    ctx.addIssue({
      code: 'custom',
      message: 'Scroll coordinates require both --x and --y'
    })
  }
  if (hasElement && (hasX || hasY)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Scroll accepts either --element-index or coordinate flags, not both'
    })
  }
})

const Drag = ComputerObserveTargetBase.extend({
  fromElementIndex: OptionalNonNegativeInt,
  toElementIndex: OptionalNonNegativeInt,
  fromX: OptionalFiniteNumber,
  fromY: OptionalFiniteNumber,
  toX: OptionalFiniteNumber,
  toY: OptionalFiniteNumber
}).superRefine((value, ctx) => {
  validateWindowTarget(value, ctx)
  const hasElementPair = value.fromElementIndex !== undefined && value.toElementIndex !== undefined
  const hasPartialElementPair =
    value.fromElementIndex !== undefined || value.toElementIndex !== undefined
  const coordinateKeys = [value.fromX, value.fromY, value.toX, value.toY]
  const hasCoordinatePair = coordinateKeys.every((coordinate) => coordinate !== undefined)
  const hasPartialCoordinatePair = coordinateKeys.some((coordinate) => coordinate !== undefined)
  if (hasElementPair && hasCoordinatePair) {
    ctx.addIssue({
      code: 'custom',
      message: 'Drag accepts either element indexes or coordinate flags, not both'
    })
  }
  if (!hasElementPair && !hasCoordinatePair) {
    ctx.addIssue({
      code: 'custom',
      message: 'Drag requires --from-element-index and --to-element-index, or all coordinate flags'
    })
  }
  if (hasPartialElementPair && !hasElementPair) {
    ctx.addIssue({
      code: 'custom',
      message: 'Drag element targeting requires both --from-element-index and --to-element-index'
    })
  }
  if (hasPartialCoordinatePair && !hasCoordinatePair) {
    ctx.addIssue({
      code: 'custom',
      message: 'Drag coordinates require --from-x, --from-y, --to-x, and --to-y'
    })
  }
})

const TypeText = ComputerObserveTargetBase.extend({
  text: requiredString('Missing text')
}).superRefine(validateWindowTarget)

const PressKey = ComputerObserveTargetBase.extend({
  key: requiredString('Missing key')
}).superRefine(validateWindowTarget)

const Hotkey = ComputerObserveTargetBase.extend({
  key: requiredString('Missing key')
}).superRefine(validateWindowTarget)

const PasteText = ComputerObserveTargetBase.extend({
  text: requiredString('Missing text')
}).superRefine(validateWindowTarget)

const SetValue = ComputerObserveTargetBase.extend({
  elementIndex: OptionalNonNegativeInt,
  value: requiredStringAllowingEmpty('Missing value')
}).superRefine((value, ctx) => {
  validateWindowTarget(value, ctx)
  if (value.elementIndex === undefined) {
    ctx.addIssue({ code: 'custom', message: 'Missing element index' })
  }
})

export function resetComputerSessionsForTest(): void {
  resetComputerSidecarForTest()
}

export const COMPUTER_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'computer.capabilities',
    params: z.object({}),
    handler: async () => {
      return await callComputerSidecarCapabilities()
    }
  }),
  defineMethod({
    name: 'computer.listApps',
    params: ListApps,
    handler: async () => {
      return await callComputerSidecarListApps()
    }
  }),
  defineMethod({
    name: 'computer.permissions',
    params: z.object({}),
    handler: async () => {
      const { openComputerUsePermissions } =
        await import('../../../computer/macos-computer-use-permissions')
      return openComputerUsePermissions()
    }
  }),
  defineMethod({
    name: 'computer.listWindows',
    params: ListWindows,
    handler: async (params) => {
      return await callComputerSidecarListWindows(params)
    }
  }),
  defineMethod({
    name: 'computer.getAppState',
    params: ComputerObserveTarget,
    handler: async (params) => {
      return await callComputerSidecarSnapshot(params)
    }
  }),
  defineMethod({
    name: 'computer.click',
    params: Click,
    handler: async (params) => {
      return await callComputerSidecarAction('click', params)
    }
  }),
  defineMethod({
    name: 'computer.performSecondaryAction',
    params: PerformSecondaryAction,
    handler: async (params) => {
      return await callComputerSidecarAction('performSecondaryAction', params)
    }
  }),
  defineMethod({
    name: 'computer.scroll',
    params: Scroll,
    handler: async (params) => {
      return await callComputerSidecarAction('scroll', params)
    }
  }),
  defineMethod({
    name: 'computer.drag',
    params: Drag,
    handler: async (params) => {
      return await callComputerSidecarAction('drag', params)
    }
  }),
  defineMethod({
    name: 'computer.typeText',
    params: TypeText,
    handler: async (params) => {
      return await callComputerSidecarAction('typeText', params)
    }
  }),
  defineMethod({
    name: 'computer.pressKey',
    params: PressKey,
    handler: async (params) => {
      return await callComputerSidecarAction('pressKey', params)
    }
  }),
  defineMethod({
    name: 'computer.hotkey',
    params: Hotkey,
    handler: async (params) => {
      return await callComputerSidecarAction('hotkey', params)
    }
  }),
  defineMethod({
    name: 'computer.pasteText',
    params: PasteText,
    handler: async (params) => {
      return await callComputerSidecarAction('pasteText', params)
    }
  }),
  defineMethod({
    name: 'computer.setValue',
    params: SetValue,
    handler: async (params) => {
      return await callComputerSidecarAction('setValue', params)
    }
  })
]
