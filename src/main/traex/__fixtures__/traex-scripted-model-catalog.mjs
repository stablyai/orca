export const models = [
  {
    id: 'contract-id',
    model: 'contract-model',
    displayName: 'Contract model',
    isDefault: true,
    hidden: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium', description: 'Medium' },
      { reasoningEffort: 'high', description: 'High' }
    ],
    businessMetadata: { variants: { max_key: 'contract-large' } }
  },
  {
    id: 'small-id',
    model: 'small-model',
    displayName: 'Standard-only model',
    isDefault: false,
    hidden: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [],
    businessMetadata: { variants: { max_key: null } }
  },
  {
    id: 'custom-id',
    model: 'custom-model',
    displayName: 'Custom model',
    modelProviderId: 'custom-provider',
    isDefault: false,
    hidden: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [],
    businessMetadata: { variants: { max_key: null } }
  }
]
