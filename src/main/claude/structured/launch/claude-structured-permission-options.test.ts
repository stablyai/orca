import { expect, it } from 'vitest'
import { claudeStructuredPermissionOptions } from './claude-structured-permission-options'

it('refuses a saved unsupported read-only mode before allowing a Claude launch', () => {
  expect(() => claudeStructuredPermissionOptions('read-only')).toThrow(
    'Claude does not support the read-only permission mode.'
  )
})
