import type { CodexModelCatalogProbeDeps } from '../codex/codex-model-catalog-probe'

/** Independent RPC transport for the scripted chat's installed-CLI discovery. */
export const scriptedCodexCatalogSession: NonNullable<
  CodexModelCatalogProbeDeps['runSession']
> = async (_invocation, body) =>
  body({
    request: async (method) => {
      if (method === 'config/read') {
        return { config: { model: 'gpt-live', model_reasoning_effort: 'medium' } }
      }
      return method === 'model/list'
        ? {
            data: [
              {
                model: 'gpt-live',
                displayName: 'GPT Live',
                isDefault: true,
                defaultReasoningEffort: 'medium',
                supportedReasoningEfforts: [
                  { reasoningEffort: 'medium', description: 'Balanced' },
                  { reasoningEffort: 'high', description: 'Deep reasoning' }
                ]
              }
            ],
            nextCursor: null
          }
        : {}
    },
    notify: () => {}
  })
