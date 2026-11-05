import { describe, expect, it } from 'vitest'

import { enablePlugin, updateConfigContent } from './hermes-config-yaml'

describe.each(['\n', '\r\n'])('Hermes flow insertion with tab separation (%j)', (eol) => {
  it('rejects an unrelated value change after repairing tab-separated insertion', () => {
    const source = 'model: "001"\nplugins: {custom: keep # note\n\t}'.replaceAll('\n', eol)
    expect(
      updateConfigContent(source, (config) => ({ ...enablePlugin(config), model: 'changed' }))
    ).toEqual({
      content: null,
      detail: 'Hermes plugin update would change unrelated configuration'
    })
  })
})
