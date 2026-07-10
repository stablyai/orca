import { z } from 'zod'
import {
  computerUseHotkeyValidationMessage,
  computerUsePressKeyValidationMessage
} from '../../../../shared/computer-use-key-spec'
import {
  OptionalBoolean,
  OptionalFiniteNumber,
  OptionalString,
  requiredString,
  requiredStringAllowingEmpty
} from '../schemas'

const OptionalNonNegativeInt = z.number().int().nonnegative().optional()
const OptionalPositiveInt = z.number().int().positive().optional()

const ComputerTarget = z.object({
  app: requiredString('Missing app'),
  session: OptionalString,
  worktree: OptionalString
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

function validateComputerTarget(
  value: { session?: string; worktree?: string; windowId?: number; windowIndex?: number },
  ctx: z.RefinementCtx
): void {
  if (value.session !== undefined && value.worktree !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'Computer-use targeting accepts either session or worktree, not both'
    })
  }
  validateWindowTarget(value, ctx)
}

export const ComputerObserveTarget = ComputerObserveTargetBase.superRefine(validateComputerTarget)

export const ListApps = z.object({}).strict()

export const ListWindows = z
  .object({
    app: requiredString('Missing app')
  })
  .strict()

export const Click = ComputerObserveTargetBase.extend({
  elementIndex: OptionalNonNegativeInt,
  x: OptionalFiniteNumber,
  y: OptionalFiniteNumber,
  clickCount: OptionalPositiveInt,
  mouseButton: z.enum(['left', 'right', 'middle']).optional()
}).superRefine((value, ctx) => {
  validateComputerTarget(value, ctx)
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

export const PerformSecondaryAction = ComputerObserveTargetBase.extend({
  elementIndex: OptionalNonNegativeInt,
  action: requiredString('Missing action')
}).superRefine((value, ctx) => {
  validateComputerTarget(value, ctx)
  if (value.elementIndex === undefined) {
    ctx.addIssue({ code: 'custom', message: 'Missing element index' })
  }
})

export const Scroll = ComputerObserveTargetBase.extend({
  elementIndex: OptionalNonNegativeInt,
  x: OptionalFiniteNumber,
  y: OptionalFiniteNumber,
  direction: z.enum(['up', 'down', 'left', 'right']),
  pages: z.number().positive().optional()
}).superRefine((value, ctx) => {
  validateComputerTarget(value, ctx)
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

export const Drag = ComputerObserveTargetBase.extend({
  fromElementIndex: OptionalNonNegativeInt,
  toElementIndex: OptionalNonNegativeInt,
  fromX: OptionalFiniteNumber,
  fromY: OptionalFiniteNumber,
  toX: OptionalFiniteNumber,
  toY: OptionalFiniteNumber
}).superRefine((value, ctx) => {
  validateComputerTarget(value, ctx)
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

export const TypeText = ComputerObserveTargetBase.extend({
  text: requiredString('Missing text')
}).superRefine(validateComputerTarget)

export const PressKey = ComputerObserveTargetBase.extend({
  key: requiredString('Missing key')
}).superRefine((value, ctx) => {
  validateComputerTarget(value, ctx)
  const message = computerUsePressKeyValidationMessage(value.key)
  if (message) {
    ctx.addIssue({ code: 'custom', message })
  }
})

export const Hotkey = ComputerObserveTargetBase.extend({
  key: requiredString('Missing key')
}).superRefine((value, ctx) => {
  validateComputerTarget(value, ctx)
  const message = computerUseHotkeyValidationMessage(value.key)
  if (message) {
    ctx.addIssue({ code: 'custom', message })
  }
})

export const ComputerPermissions = z.object({
  id: z.enum(['accessibility', 'screenshots']).optional()
})

export const PasteText = ComputerObserveTargetBase.extend({
  text: requiredString('Missing text')
}).superRefine(validateComputerTarget)

export const SetValue = ComputerObserveTargetBase.extend({
  elementIndex: OptionalNonNegativeInt,
  value: requiredStringAllowingEmpty('Missing value')
}).superRefine((value, ctx) => {
  validateComputerTarget(value, ctx)
  if (value.elementIndex === undefined) {
    ctx.addIssue({ code: 'custom', message: 'Missing element index' })
  }
})
