import { extractString } from '../../shared/text/trimmed-string'

// thread/fork does not inherit the parent's model; without one the copy is saved and
// later resumed on the config default. The source chat keeps its thread's provider
// (resume and turn/start only override the model), so the fork takes that provider too.
export function codexForkModelOverrides(
  selectedModel: string | undefined,
  sourceThread: Record<string, unknown> | null | undefined
): { model?: string; modelProvider?: string } {
  const model = extractString(selectedModel) ?? extractString(sourceThread?.model)
  const modelProvider = extractString(sourceThread?.modelProvider)
  return model ? { model, ...(modelProvider ? { modelProvider } : {}) } : {}
}
