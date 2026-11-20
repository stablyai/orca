import type { SessionConfigOption } from '../generated/acp-protocol.generated'

export type AcpOptionWrite =
  | { method: 'config'; configId: string; value: string }
  | { method: 'model'; modelId: string }

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>

/** An on/off effort rewrites the model id's thinking variant instead of an effort config value. */
export function acpThinkingVariantEffortWrite(
  modelOption: SelectOption | null,
  value: string
): AcpOptionWrite | null {
  if (!modelOption || (value !== 'off' && value !== 'on')) {
    return null
  }
  const base = modelOption.currentValue.replace(/:v:.*$/, '')
  return {
    method: 'config',
    configId: modelOption.id,
    value: value === 'off' ? `${base}:v:` : `${base}:v:thinking`
  }
}
