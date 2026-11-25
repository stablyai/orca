import type { SessionConfigOption } from '../generated/acp-protocol.generated'
import type { AcpDialect } from '../acp-dialects/acp-dialect'
import {
  mcodeModelId,
  parseMcodeModelId
} from '../../../shared/agent-session/options/catalog-providers/agent-session-option-catalog-mcode'

export type AcpOptionWrite =
  | { method: 'config'; configId: string; value: string }
  | { method: 'model'; modelId: string }

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>
type VariantDialect = Pick<AcpDialect, 'effortSelectsThinkingVariant'>

/** Whether an effort pick of this dialect rewrites the model's thinking variant. */
export function isAcpThinkingVariantEffortPick(
  dialect: VariantDialect,
  key: string,
  value: string
): boolean {
  return (
    key === 'effort' &&
    dialect.effortSelectsThinkingVariant === true &&
    (value === 'off' || value === 'on')
  )
}

/** An on/off effort rewrites the model id's thinking variant instead of an effort config value. */
export function acpThinkingVariantEffortWrite(
  dialect: VariantDialect,
  modelOption: SelectOption | null,
  key: string,
  value: string
): AcpOptionWrite | null {
  // Only a model listed with thinking variants can switch its thinking off and on.
  const current =
    modelOption && isAcpThinkingVariantEffortPick(dialect, key, value)
      ? parseMcodeModelId(modelOption.currentValue)
      : null
  if (!modelOption || current?.variant === undefined) {
    return null
  }
  return {
    method: 'config',
    configId: modelOption.id,
    value: mcodeModelId({ ...current, variant: value === 'off' ? '' : 'thinking' })
  }
}
