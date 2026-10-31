export function getOmpModelCommandSourceLines(): string[] {
  return [
    "  if (isOmpRuntime() && typeof pi.registerCommand === 'function' && typeof pi.setModel === 'function') {",
    "    pi.registerCommand('orca-model', {",
    "      description: 'Switch the model selected in Orca',",
    '      handler: async (selector, ctx) => {',
    '        const models = ctx.modelRegistry.getAvailable()',
    "        const model = models.find((candidate) => candidate.provider + '/' + candidate.id === selector.trim())",
    '        if (!model) {',
    "          ctx.ui.notify('Model is no longer available. Refresh the Orca model picker.', 'error')",
    '          return',
    '        }',
    '        if (!await pi.setModel(model)) {',
    "          ctx.ui.notify('Could not switch model: no API key is available.', 'error')",
    '          return',
    '        }',
    '        updateRuntimeOmpSessionMetadata(ctx)',
    '        updateModelMetadata({ model })',
    "        post('model_select')",
    '      }',
    '    })',
    '    ompModelSwitchSupported = true',
    '  }'
  ]
}
