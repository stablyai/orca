import { strict as assert } from 'node:assert'
import { test } from 'vitest'

import { repairTranslatedValue } from './locale-translation-policy.mjs'

test('Korean refresh repairs preserve verb endings and explicit mappings', () => {
  const repair = (enValue, localeValue) =>
    repairTranslatedValue({ key: 'test.refresh', enValue, localeValue, locale: 'ko' })

  assert.equal(repair('Refresh the task', '새로 고치려면'), '새로 고치려면')
  assert.equal(repair('Refresh the review', '새로 고치거나'), '새로 고치거나')
  assert.equal(repair('Refresh', '새로 고치다'), '새로고침')
  assert.equal(repair('Refreshing now', '새로 고치는 중'), '새로고침 중')
  assert.equal(repair('Refresh failed', '새로 고치지'), '새로고침하지')
  assert.equal(repair('Refresh and retry', '새로 고치고'), '새로고침하고')
  assert.equal(repair('Open', '새로 고치려면'), '새로 고치려면')
})
