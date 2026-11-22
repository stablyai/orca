import { describe, expect, it } from 'vitest'
import { modelsNeedingCliUpdate } from './agent-cli-model-requirements'

const list = {
  models: [
    { agent: 'codex', id: 'gpt-6.3-sol', name: 'GPT-6.3-Sol', minVersion: '0.172.0' },
    { agent: 'codex', id: 'gpt-6.2-astra', name: 'GPT-6.2-Astra', minVersion: '0.169.1' },
    { agent: 'codex', id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', minVersion: '0.98.0' },
    { agent: 'claude', id: 'claude-opus-5-5', name: 'Opus 5.5', minVersion: '2.1.280' }
  ]
}

describe('modelsNeedingCliUpdate', () => {
  it('lists only models the installed CLI is too old for and the latest release brings', () => {
    expect(modelsNeedingCliUpdate(list, 'codex', '0.99.0', '0.170.0')).toEqual([
      { id: 'gpt-6.2-astra', name: 'GPT-6.2-Astra', minVersion: '0.169.1' }
    ])
  })
})
