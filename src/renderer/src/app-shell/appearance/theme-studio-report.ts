import { completePluginAppThemeTokens } from '../../../../shared/plugins/artifacts/plugin-theme-artifact'
import { pluginThemeTokenReference } from '../../../../shared/plugins/artifacts/plugin-theme-token-reference-doc'
import { formatThemeColor } from '../../../../shared/color/oklch-color-transform'
import { lightnessForContrast, oklabDistance } from '../../../../shared/color/oklch-contrast-fix'
import { contrastRatio, type Rgba } from '../../../../shared/color/rgba-contrast'
import {
  THEME_STUDIO_MODES,
  type ThemeStudioDraft,
  type ThemeStudioMode
} from '../../../../shared/theme-studio/theme-studio-draft'
import type {
  ThemeStudioFinding,
  ThemeStudioFix,
  ThemeStudioReport
} from '../../../../shared/theme-studio/theme-studio-findings'
import {
  evaluatePluginThemeTokens,
  type ColorProbe,
  type PluginThemeTokenDrop
} from './plugin-theme-tokens'

// Why a margin: a fix exactly at the minimum can round under it once written as hex.
const FIX_MARGIN = 0.1
const SAFE_BORDER_ALPHA = 0.12
const round = (value: number, digits = 2): number => Number(value.toFixed(digits))

let roles: Map<string, string> | null = null
/** What a token paints, in the words of the token reference ("Left workspace sidebar"). */
function roleOf(token: string): string {
  roles ??= new Map(pluginThemeTokenReference().map(({ token: name, paints }) => [name, paints]))
  return roles.get(token)?.replaceAll('`', '') ?? token.replace(/^--/, '').replaceAll('-', ' ')
}

function effectOf(tokens: readonly string[], surface: string | undefined): string {
  const area = roleOf(
    tokens.find((token) => !token.endsWith('-foreground')) ?? surface ?? tokens[0] ?? ''
  )
  return `${area} will show Orca's built-in colors instead of the draft's.`
}

const idOf = (mode: ThemeStudioMode, rule: string, ...parts: (string | undefined)[]): string =>
  [mode, rule, ...parts.filter(Boolean).map((part) => part?.replace(/^--/, ''))].join('-')

/** The lightness-only fix for `token` (now `color`) to read against `against`. */
function lightnessFix(
  strategy: ThemeStudioFix['strategy'],
  token: string,
  color: Rgba,
  against: Rgba,
  min: number
): ThemeStudioFix | null {
  const fixed = lightnessForContrast(color, against, min + FIX_MARGIN)
  return fixed
    ? {
        strategy,
        set: { [token]: formatThemeColor(fixed) },
        ratio: round(contrastRatio(fixed, against)),
        deltaE: round(oklabDistance(color, fixed), 3)
      }
    : null
}

function findingFor(
  mode: ThemeStudioMode,
  drop: PluginThemeTokenDrop,
  owned: Readonly<Record<string, string>>,
  probe: ColorProbe
): ThemeStudioFinding {
  const ownedOnly = (tokens: readonly string[]): string[] =>
    tokens.filter((token) => owned[token] !== undefined)
  switch (drop.kind) {
    case 'invalid':
      return {
        id: idOf(mode, 'invalid', drop.token),
        rule: 'invalid',
        tokens: ownedOnly([drop.token]),
        effect: `${roleOf(drop.token)} is not a color Orca can paint.`,
        fixes: []
      }
    case 'border-alpha': {
      const color = probe(drop.value)
      return {
        id: idOf(mode, 'border', drop.token),
        rule: 'border',
        tokens: ownedOnly([drop.token]),
        min: drop.min,
        effect: `${roleOf(drop.token)} would be invisible.`,
        fixes:
          color && owned[drop.token]
            ? [
                {
                  strategy: 'border-alpha',
                  set: {
                    [drop.token]: formatThemeColor([
                      color[0],
                      color[1],
                      color[2],
                      SAFE_BORDER_ALPHA
                    ])
                  }
                }
              ]
            : []
      }
    }
    case 'ring': {
      const fix = owned[drop.token]
        ? lightnessFix('text-lightness', drop.token, drop.ringColor, drop.surfaceColor, drop.min)
        : null
      return {
        id: idOf(mode, 'ring', drop.token, 'on', drop.surface),
        rule: 'ring',
        tokens: ownedOnly([drop.token]),
        surface: drop.surface,
        ratio: round(drop.ratio),
        min: drop.min,
        effect: `${roleOf(drop.token)} would vanish on ${roleOf(drop.surface).toLowerCase()}.`,
        fixes: fix ? [fix] : []
      }
    }
    case 'contrast': {
      // Why both sides: text keeps the theme's surfaces; a surface fix keeps a chosen text color.
      const fixes =
        drop.ratio === null
          ? []
          : [
              owned[drop.text] && drop.textColor[3] === 1
                ? lightnessFix(
                    'text-lightness',
                    drop.text,
                    drop.textColor,
                    drop.surfaceColor,
                    drop.min
                  )
                : null,
              owned[drop.surface] && probe(owned[drop.surface])?.[3] === 1
                ? lightnessFix(
                    'surface-lightness',
                    drop.surface,
                    drop.surfaceColor,
                    drop.textColor,
                    drop.min
                  )
                : null
            ]
              .filter((fix) => fix !== null)
              .sort((left, right) => (left.deltaE ?? 0) - (right.deltaE ?? 0))
      const rule = drop.text.startsWith('--git-decoration-') ? 'status' : 'text'
      const id = idOf(mode, rule, drop.text, 'on', drop.surface)
      return {
        id,
        rule,
        tokens: ownedOnly(drop.dropped),
        text: drop.text,
        surface: drop.surface,
        ratio: drop.ratio === null ? null : round(drop.ratio),
        min: round(drop.min),
        effect: effectOf(drop.dropped, drop.surface),
        fixes,
        ...(fixes.length ? { command: `orca theme check --fix --finding ${id}` } : {})
      }
    }
  }
}

/** What the contrast check drops from each mode of a draft, with the smallest fixes that pass. */
export function themeStudioReport(input: {
  revision: number
  draft: ThemeStudioDraft
  shownMode: ThemeStudioMode
  builtIns: (mode: ThemeStudioMode) => Record<string, string>
  probe: ColorProbe
}): ThemeStudioReport {
  const modes = THEME_STUDIO_MODES.flatMap((mode) => {
    const variant = input.draft[mode]
    if (!variant) {
      return []
    }
    const { drops } = evaluatePluginThemeTokens(
      completePluginAppThemeTokens(variant.tokens),
      mode,
      input.builtIns(mode),
      input.probe
    )
    // Why dedupe: one pair is checked over several layers (chat), and the agent fixes it once.
    const findings = drops
      .map((drop) => findingFor(mode, drop, variant.tokens, input.probe))
      .filter((finding, index, all) => all.findIndex((other) => other.id === finding.id) === index)
    return [{ mode, shown: mode === input.shownMode, findings }]
  })
  return { revision: input.revision, modes }
}
