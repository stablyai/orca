import { readFile } from 'node:fs/promises'
import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/types'
import type { ThemeColorAdjustment } from '../../shared/color/oklch-color-transform'
import {
  THEME_STUDIO_MODES,
  THEME_STUDIO_TERMINAL_PREFIX,
  type ThemeStudioMode,
  type ThemeStudioPatch
} from '../../shared/theme-studio/theme-studio-draft'
import { listFlag, localPath, numberFlag, stringFlag } from './theme-command-io'

const ADJUSTMENT_FLAGS: readonly (keyof ThemeColorAdjustment)[] = [
  'warmth',
  'hue',
  'saturation',
  'lightness',
  'contrast'
]

/** The --warmth, --hue, --saturation, --lightness and --contrast values given. */
export function adjustmentFlags(ctx: HandlerContext): ThemeColorAdjustment {
  return Object.fromEntries(
    ADJUSTMENT_FLAGS.flatMap((key) => {
      const value = numberFlag(ctx, key)
      return value === undefined ? [] : [[key, value]]
    })
  )
}

/** Parses `key=value` assignments into a patch for each selected mode. */
export function assignmentsPatch(ctx: HandlerContext, modes: ThemeStudioMode[]): ThemeStudioPatch {
  const set: Record<string, string> = {}
  for (const assignment of listFlag(ctx, 'assignment')) {
    const equals = assignment.indexOf('=')
    if (equals <= 0) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Expected <token>=<color>, got "${assignment}".`,
        {
          nextSteps: ['Write tokens without the leading dashes, such as `sidebar=#20160f`.']
        }
      )
    }
    set[assignment.slice(0, equals).trim()] = assignment.slice(equals + 1).trim()
  }
  const unset = listFlag(ctx, 'unset')
  const patch: ThemeStudioPatch = {}
  if (Object.keys(set).length || unset.length) {
    for (const mode of modes) {
      patch[mode] = {
        ...(Object.keys(set).length ? { set } : {}),
        ...(unset.length ? { unset } : {})
      }
    }
  }
  return patch
}

export async function patchFlag(ctx: HandlerContext): Promise<unknown> {
  const value = stringFlag(ctx, 'patch')
  if (value === undefined) {
    return undefined
  }
  const text = value.startsWith('@')
    ? await readFile(localPath(ctx, value.slice(1), 'set'), 'utf8')
    : value
  try {
    return JSON.parse(text)
  } catch {
    throw new RuntimeClientError('invalid_argument', '--patch is not valid JSON.')
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Merges --patch with assignments; both may name the same mode. */
export function mergePatches(fromFlag: unknown, fromAssignments: ThemeStudioPatch): unknown {
  if (fromFlag === undefined) {
    return fromAssignments
  }
  if (!isRecord(fromFlag)) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--patch must be an object keyed by light and dark.'
    )
  }
  const merged: Record<string, unknown> = { ...fromFlag }
  for (const mode of THEME_STUDIO_MODES) {
    const extra = fromAssignments[mode]
    const base = merged[mode]
    if (extra) {
      merged[mode] = isRecord(base)
        ? {
            ...base,
            set: { ...(isRecord(base.set) ? base.set : {}), ...extra.set },
            unset: [...(Array.isArray(base.unset) ? base.unset : []), ...(extra.unset ?? [])]
          }
        : extra
    }
  }
  return merged
}

export function onlyPrefixes(ctx: HandlerContext): string[] | undefined {
  const value = stringFlag(ctx, 'only')
  if (!value) {
    return undefined
  }
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) =>
      part.startsWith('--') ||
      part.startsWith(THEME_STUDIO_TERMINAL_PREFIX) ||
      part.startsWith('tokenColors')
        ? part
        : `--${part}`
    )
}
