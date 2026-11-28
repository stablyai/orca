import { expect, it } from 'vitest'
import { buildManagedKimiHooksBlock, removeManagedKimiHooks } from './kimi-hook-config-toml'

it('preserves marker and hook examples inside a user multiline string during removal', () => {
  const template = `prompt_template = '''
# >>> orca-managed-kimi-hooks (managed by Orca; do not edit) >>>
[[hooks]]
event = "Stop"
command = "/orca-hook"
# <<< orca-managed-kimi-hooks <<<
'''
model = "keep-me"\n`
  const config = `${template}\n${buildManagedKimiHooksBlock('/orca-hook')}\n`

  expect(removeManagedKimiHooks(config, (command) => command === '/orca-hook')).toEqual({
    text: template,
    changed: true
  })
})
